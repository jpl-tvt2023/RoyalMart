-- Soft delete for marketplace_pos: allow status 'Deleted' so deleting a PO
-- retains the row (hidden from normal views, restorable) instead of removing it.
-- SQLite cannot ALTER a CHECK constraint in place, so we rebuild the table
-- exactly like migration 023, widening the status CHECK to include 'Deleted'
-- and reproducing every column added since (party_name, bill_no, GRN fields,
-- note, procurement fields). Indexes do not survive the rebuild and are
-- recreated below. The migration runner splits on ASCII semicolons, so this
-- file keeps them out of comments.

CREATE TABLE marketplace_pos_new (
  po_id                  TEXT PRIMARY KEY,
  vendor                 TEXT NOT NULL,
  vendor_po_id           TEXT NOT NULL,
  po_date                TEXT,
  expected_delivery_date TEXT,
  po_expiry_date         TEXT,
  city                   TEXT,
  onboarded_by           INTEGER REFERENCES users(id),
  updated_by             INTEGER REFERENCES users(id),
  status                 TEXT NOT NULL DEFAULT 'Open' CHECK (status IN ('Open','Closed','Deleted')),
  office_poc             INTEGER REFERENCES users(id),
  warehouse_poc          INTEGER REFERENCES users(id),
  dispatch_date          TEXT,
  courier_id             INTEGER REFERENCES couriers(id),
  tracking_id            TEXT,
  created_by             INTEGER NOT NULL REFERENCES users(id),
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
  party_name             TEXT,
  bill_no                TEXT,
  appointment_date       TEXT,
  asn                    TEXT,
  grn_status             TEXT,
  grn_date               TEXT,
  grn_qty                INTEGER,
  grn_number             TEXT,
  discrepancy_qty        INTEGER,
  discrepancy_number     TEXT,
  note                   TEXT,
  procurement_batch_id   INTEGER REFERENCES procurement_batches(id),
  raw_ordered_at         TEXT,
  UNIQUE (vendor, vendor_po_id)
);

INSERT INTO marketplace_pos_new
  (po_id, vendor, vendor_po_id, po_date, expected_delivery_date, po_expiry_date, city,
   onboarded_by, updated_by, status, office_poc, warehouse_poc, dispatch_date,
   courier_id, tracking_id, created_by, created_at, updated_at,
   party_name, bill_no, appointment_date, asn, grn_status, grn_date, grn_qty,
   grn_number, discrepancy_qty, discrepancy_number, note, procurement_batch_id, raw_ordered_at)
SELECT po_id, vendor, vendor_po_id, po_date, expected_delivery_date, po_expiry_date, city,
       onboarded_by, updated_by, status, office_poc, warehouse_poc, dispatch_date,
       courier_id, tracking_id, created_by, created_at, updated_at,
       party_name, bill_no, appointment_date, asn, grn_status, grn_date, grn_qty,
       grn_number, discrepancy_qty, discrepancy_number, note, procurement_batch_id, raw_ordered_at
FROM marketplace_pos;

DROP TABLE marketplace_pos;

ALTER TABLE marketplace_pos_new RENAME TO marketplace_pos;

CREATE INDEX IF NOT EXISTS idx_marketplace_pos_tracking_id
  ON marketplace_pos(tracking_id) WHERE tracking_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_marketplace_pos_bill_no
  ON marketplace_pos(bill_no) WHERE bill_no IS NOT NULL;
