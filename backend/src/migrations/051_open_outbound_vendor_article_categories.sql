-- Category/item_name on outbound_vendor_articles used to be constrained to a
-- hardcoded CHECK list. Categories are now open-ended, driven by whatever
-- exists in packaging_raw_materials. Backfill that table with every
-- category/item_name pair already in use (canonical known values, plus any
-- real historical values including free-text 'Others' entries) so nothing
-- already mapped becomes unselectable, then rebuild the table without the
-- CHECK constraint (SQLite can't drop a CHECK constraint in place).

INSERT INTO packaging_raw_materials (category, item_name, unit_metric) VALUES
  ('Raw Material', 'Caps', 'pcs'),
  ('Raw Material', 'Handkerchief', 'pcs'),
  ('Raw Material', 'Bandana', 'pcs'),
  ('Raw Material', 'Socks', 'pcs'),
  ('Packaging', 'Corrugated', 'pcs'),
  ('Packaging', 'One Ply', 'pcs')
ON CONFLICT (category, item_name) DO NOTHING;

INSERT INTO packaging_raw_materials (category, item_name, unit_metric)
SELECT DISTINCT category, item_name, 'pcs'
FROM outbound_vendor_articles
WHERE category IS NOT NULL AND item_name IS NOT NULL
ON CONFLICT (category, item_name) DO NOTHING;

CREATE TABLE outbound_vendor_articles_new (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  vendor_id  INTEGER NOT NULL REFERENCES outbound_vendors(id) ON DELETE CASCADE,
  category   TEXT NOT NULL,
  item_name  TEXT NOT NULL,
  variant    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO outbound_vendor_articles_new (id, vendor_id, category, item_name, variant, created_at)
SELECT id, vendor_id, category, item_name, variant, created_at FROM outbound_vendor_articles;

DROP TABLE outbound_vendor_articles;
ALTER TABLE outbound_vendor_articles_new RENAME TO outbound_vendor_articles;

CREATE INDEX IF NOT EXISTS idx_outbound_vendor_articles_vendor
  ON outbound_vendor_articles(vendor_id);
