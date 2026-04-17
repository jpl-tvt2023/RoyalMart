CREATE TABLE IF NOT EXISTS supplier_pos (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_name TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'Ordered'
                  CHECK (status IN ('Ordered','In-Transit','Arrived','Received')),
  sku_id        INTEGER NOT NULL REFERENCES products(id),
  quantity      INTEGER NOT NULL CHECK (quantity > 0),
  created_by    INTEGER NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
)
