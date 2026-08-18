-- Barcode procurement gets its own batch tracking, mirroring the packaging
-- batching added in 062 (which in turn mirrors the raw-material batching in
-- 032).
--
-- Until now a single packaging_procurement_batch_id covered packaging AND
-- barcode demand together, because both were shown on one Outbound tab. Now
-- that Packaging Material and Barcode are separate tabs, marking one ordered
-- must not silently mark the other -- the two are bought from different vendors
-- on different schedules, exactly the reasoning that split packaging away from
-- raw materials in the first place.
--
-- Existing packaging batches are left alone. A marketplace PO already marked
-- packaging-ordered therefore starts out barcode-pending, which is the honest
-- default: nothing in the old data records whether its barcodes were actually
-- ordered.
CREATE TABLE IF NOT EXISTS procurement_barcode_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  po_date_from TEXT,
  po_date_to TEXT,
  po_count INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
ALTER TABLE marketplace_pos ADD COLUMN barcode_procurement_batch_id INTEGER REFERENCES procurement_barcode_batches(id);
ALTER TABLE marketplace_pos ADD COLUMN barcode_ordered_at TEXT
