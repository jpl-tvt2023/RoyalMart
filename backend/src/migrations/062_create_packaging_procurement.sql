-- Outbound (packaging) procurement mirrors the existing raw-material
-- procurement batching (032_create_procurement.sql) but tracks packaging/
-- barcode ordering independently of raw-material ordering, since the two are
-- ordered from different vendors on different schedules. A marketplace PO can
-- therefore be raw-ordered and packaging-ordered at different times.
CREATE TABLE IF NOT EXISTS procurement_packaging_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  po_date_from TEXT,
  po_date_to TEXT,
  po_count INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
ALTER TABLE marketplace_pos ADD COLUMN packaging_procurement_batch_id INTEGER REFERENCES procurement_packaging_batches(id);
ALTER TABLE marketplace_pos ADD COLUMN packaging_ordered_at TEXT
