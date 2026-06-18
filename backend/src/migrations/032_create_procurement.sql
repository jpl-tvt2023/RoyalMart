CREATE TABLE IF NOT EXISTS procurement_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  po_date_from TEXT,
  po_date_to TEXT,
  po_count INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
ALTER TABLE marketplace_pos ADD COLUMN procurement_batch_id INTEGER REFERENCES procurement_batches(id);
ALTER TABLE marketplace_pos ADD COLUMN raw_ordered_at TEXT
