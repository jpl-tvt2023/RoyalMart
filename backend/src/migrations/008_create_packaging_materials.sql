CREATE TABLE IF NOT EXISTS packaging_materials (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT UNIQUE NOT NULL,
  unit             TEXT NOT NULL DEFAULT 'pcs',
  on_hand_qty      INTEGER NOT NULL DEFAULT 0,
  safety_threshold INTEGER NOT NULL DEFAULT 0,
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
)
