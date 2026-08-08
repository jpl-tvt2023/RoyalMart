-- The Outbound Product List: the taxonomy layer that sits above
-- packaging_raw_materials. One row per (Category, Item Name) with the unit
-- metric that item is always measured in.
--
-- Until now Category / Item Name / Unit Metric were free text at the point of
-- onboarding on /packaging-items, while every downstream consumer (outbound
-- vendor article mappings, outbound PO lines) validated strictly against that
-- catalog. A typo typed once at onboarding therefore propagated into the option
-- lists everywhere else, and the intended taxonomy -- Raw Material / Packaging
-- / Barcode / Others -- lived only in migration comments and data. This table
-- makes it explicit and enforceable.
--
-- Variant deliberately stays OUT of this table. Variant is an attribute of the
-- onboarded product, not of the taxonomy, so it remains free text on
-- packaging_raw_materials and part of that table's identity triple.
--
-- category / item_name are COLLATE NOCASE so the UNIQUE index is
-- case-insensitive. Keeping "Packaging" from fragmenting into "packaging" is
-- the whole point of the feature. packaging_raw_materials itself is
-- case-sensitive, so its controller canonicalises casing against this table on
-- write and the two stay aligned.
--
-- Soft delete via is_active rather than DELETE: deactivating a row must hide it
-- from the onboarding dropdowns without disturbing products already onboarded
-- against it.

CREATE TABLE IF NOT EXISTS outbound_products (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  category    TEXT NOT NULL COLLATE NOCASE,
  item_name   TEXT NOT NULL COLLATE NOCASE,
  unit_metric TEXT NOT NULL,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by  INTEGER REFERENCES users(id),
  updated_at  TEXT,
  UNIQUE (category, item_name)
);

CREATE INDEX IF NOT EXISTS idx_outbound_products_lookup
  ON outbound_products(category, item_name);

-- Seed from the pairs already onboarded so validation does not invalidate the
-- existing catalog on day one. GROUP BY LOWER(...) collapses case variants and
-- multi-variant items down to one row each, and INSERT OR IGNORE absorbs any
-- residual collision against the NOCASE unique index.
--
-- Where one pair has rows with differing unit metrics, an arbitrary one wins --
-- the seeded list is meant to be reviewed once after this migration runs.
INSERT OR IGNORE INTO outbound_products (category, item_name, unit_metric)
SELECT category, item_name, unit_metric
FROM packaging_raw_materials
GROUP BY LOWER(category), LOWER(item_name)
