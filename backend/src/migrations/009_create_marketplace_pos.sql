CREATE TABLE IF NOT EXISTS marketplace_pos (
  po_id                  TEXT PRIMARY KEY,
  vendor                 TEXT NOT NULL CHECK (vendor IN ('Swiggy','Zepto','Blinkit')),
  vendor_po_id           TEXT NOT NULL,
  po_date                TEXT,
  expected_delivery_date TEXT,
  po_expiry_date         TEXT,
  created_by             INTEGER NOT NULL REFERENCES users(id),
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (vendor, vendor_po_id)
);

CREATE TABLE IF NOT EXISTS marketplace_po_lines (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  po_id      TEXT NOT NULL REFERENCES marketplace_pos(po_id) ON DELETE CASCADE,
  line_no    INTEGER NOT NULL,
  item_code  TEXT NOT NULL,
  item_desc  TEXT,
  qty        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mpo_lines_po ON marketplace_po_lines(po_id)
