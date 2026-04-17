CREATE TABLE IF NOT EXISTS products (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  sku_code         TEXT UNIQUE NOT NULL,
  name             TEXT NOT NULL,
  hsn_code         TEXT,
  fabric_type      TEXT,
  gsm              INTEGER,
  color            TEXT,
  safety_threshold INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
)
