CREATE TABLE IF NOT EXISTS product_vendor_codes (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id       INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  vendor           TEXT NOT NULL,
  vendor_item_code TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (vendor, vendor_item_code)
);
CREATE INDEX IF NOT EXISTS idx_pvc_product ON product_vendor_codes(product_id);
