-- Promote packaging_raw_materials into THE master article catalog. It gains a
-- variant column so (Category, Item Name, Variant) becomes the unit of identity
-- that outbound vendors map to and outbound PO lines copy from. This inverts
-- the old flow, where the "Packaging Products" view was derived back out of
-- vendor mappings -- products now exist in their own right and vendor mappings
-- point at them.
--
-- The old inline UNIQUE (category, item_name) has to go, since two variants of
-- one item are now legitimate, and SQLite cannot drop a table constraint in
-- place. Hence the create-new / copy / drop / rename rebuild.
--
-- SAFETY: no table anywhere declares REFERENCES packaging_raw_materials, so
-- this DROP cascade-deletes nothing. Row ids are carried across verbatim so
-- audit_logs rows keyed on packaging_raw_material ids stay attached.
--
-- variant is NOT NULL DEFAULT '' rather than nullable because SQLite treats
-- NULLs as distinct inside a UNIQUE index -- a nullable variant would silently
-- allow unlimited duplicate no-variant rows and break the ON CONFLICT dedupe
-- in bulkUpsert. '' is the canonical "no variant" and the controller maps it
-- back to null on the way out.

CREATE TABLE packaging_raw_materials_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  category    TEXT NOT NULL,
  item_name   TEXT NOT NULL,
  variant     TEXT NOT NULL DEFAULT '',
  unit_metric TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by  INTEGER REFERENCES users(id),
  updated_at  TEXT,
  UNIQUE (category, item_name, variant)
);

INSERT INTO packaging_raw_materials_new
  (id, category, item_name, variant, unit_metric, created_at, updated_by, updated_at)
SELECT id, category, item_name, '', unit_metric, created_at, updated_by, updated_at
FROM packaging_raw_materials;

DROP TABLE packaging_raw_materials;

ALTER TABLE packaging_raw_materials_new RENAME TO packaging_raw_materials;

-- Backfill every (category, item_name, variant) triple that outbound vendors
-- already have mapped but that has no catalog row yet. Variant used to be free
-- text on outbound_vendor_articles, so those triples would become invalid and
-- unselectable the moment validation starts matching on the full triple. Same
-- technique as migration 051.
--
-- unit_metric is inherited from the matching no-variant catalog row where one
-- exists, else defaults to 'pcs'. The inheritance is written as a LEFT JOIN
-- over a subquery rather than a correlated subquery, because reading the same
-- table being inserted into mid-statement has undefined ordering in SQLite.
--
-- Deliberately NOT backfilling triples from outbound_po_lines -- historical
-- free-text variants would pollute the master, and those lines are already
-- grandfathered by validateLines in the outbound PO controller.
INSERT INTO packaging_raw_materials (category, item_name, variant, unit_metric)
SELECT DISTINCT a.category, a.item_name, COALESCE(a.variant, ''), COALESCE(u.unit_metric, 'pcs')
FROM outbound_vendor_articles a
LEFT JOIN (SELECT category, item_name, MIN(unit_metric) AS unit_metric
           FROM packaging_raw_materials GROUP BY category, item_name) u
  ON u.category = a.category AND u.item_name = a.item_name
WHERE a.category IS NOT NULL AND a.item_name IS NOT NULL
ON CONFLICT (category, item_name, variant) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_packaging_raw_materials_lookup
  ON packaging_raw_materials(category, item_name, variant)
