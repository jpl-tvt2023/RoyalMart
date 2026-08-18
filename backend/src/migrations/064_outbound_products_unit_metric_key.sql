-- Unit metric joins the identity of an Outbound Product.
--
-- The original UNIQUE (category, item_name) from migration 059 made it
-- impossible to list one item under two metrics. "Barcode / Barcode / pcs" and
-- "Barcode / Barcode / mtr" are both legitimate products, but the second was
-- rejected as a duplicate of the first. Unit metric therefore becomes part of
-- the key rather than a mere attribute of the pair.
--
-- SQLite cannot drop a table constraint in place, so this is the same
-- create-new / copy / drop / rename rebuild migration 056 used on
-- packaging_raw_materials. Row ids are carried across verbatim so audit_logs
-- rows keyed on outbound_product ids stay attached.
--
-- SAFETY: no table anywhere declares REFERENCES outbound_products, so this DROP
-- cascade-deletes nothing.
--
-- unit_metric gains COLLATE NOCASE to match category and item_name. Now that it
-- is part of the key, letting "pcs" and "PCS" coexist would fragment the
-- taxonomy in exactly the way migration 059 set out to prevent.
--
-- idx_outbound_products_lookup is recreated as a PLAIN index. It exists to make
-- the (category, item_name) lookups in packagingRawMaterials.controller fast --
-- it was never the uniqueness mechanism, and that pair is now legitimately
-- non-unique.

CREATE TABLE outbound_products_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  category    TEXT NOT NULL COLLATE NOCASE,
  item_name   TEXT NOT NULL COLLATE NOCASE,
  unit_metric TEXT NOT NULL COLLATE NOCASE,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by  INTEGER REFERENCES users(id),
  updated_at  TEXT,
  UNIQUE (category, item_name, unit_metric)
);

INSERT INTO outbound_products_new
  (id, category, item_name, unit_metric, is_active, created_at, updated_by, updated_at)
SELECT id, category, item_name, unit_metric, is_active, created_at, updated_by, updated_at
FROM outbound_products;

DROP TABLE outbound_products;

ALTER TABLE outbound_products_new RENAME TO outbound_products;

CREATE INDEX IF NOT EXISTS idx_outbound_products_lookup
  ON outbound_products(category, item_name)
