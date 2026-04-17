CREATE TABLE IF NOT EXISTS inventory (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  sku_id         INTEGER UNIQUE NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  on_hand_qty    INTEGER NOT NULL DEFAULT 0,
  in_transit_qty INTEGER NOT NULL DEFAULT 0,
  committed_qty  INTEGER NOT NULL DEFAULT 0,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
)
