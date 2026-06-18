ALTER TABLE products ADD COLUMN description TEXT;
ALTER TABLE products ADD COLUMN category TEXT;
UPDATE products SET description = name;
ALTER TABLE products DROP COLUMN name;
ALTER TABLE products DROP COLUMN fabric_type;
ALTER TABLE products DROP COLUMN gsm;
ALTER TABLE products DROP COLUMN color;
ALTER TABLE products DROP COLUMN safety_threshold;
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS product_requirements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  raw_product_id INTEGER NOT NULL REFERENCES raw_products(id),
  qty INTEGER NOT NULL DEFAULT 0,
  UNIQUE (product_id, raw_product_id)
);
CREATE INDEX IF NOT EXISTS idx_product_requirements_product ON product_requirements(product_id)
