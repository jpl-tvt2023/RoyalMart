-- Rename the Swiggy vendor to Scootsy across all tables and update CHECK
-- constraints. The marketplace_pos.vendor CHECK currently lists only
-- ('Swiggy','Zepto','Blinkit'), so we rebuild the table directly with the
-- renamed value (UPDATE-in-place would fail the CHECK).

CREATE TABLE marketplace_pos_new (
  po_id                  TEXT PRIMARY KEY,
  vendor                 TEXT NOT NULL CHECK (vendor IN ('Scootsy','Zepto','Blinkit')),
  vendor_po_id           TEXT NOT NULL,
  po_date                TEXT,
  expected_delivery_date TEXT,
  po_expiry_date         TEXT,
  city                   TEXT,
  onboarded_by           INTEGER REFERENCES users(id),
  updated_by             INTEGER REFERENCES users(id),
  status                 TEXT NOT NULL DEFAULT 'Open' CHECK (status IN ('Open','Closed')),
  created_by             INTEGER NOT NULL REFERENCES users(id),
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (vendor, vendor_po_id)
);

INSERT INTO marketplace_pos_new
  (po_id, vendor, vendor_po_id, po_date, expected_delivery_date, po_expiry_date, city,
   onboarded_by, updated_by, status, created_by, created_at, updated_at)
SELECT po_id,
       CASE WHEN vendor = 'Swiggy' THEN 'Scootsy' ELSE vendor END,
       vendor_po_id, po_date, expected_delivery_date, po_expiry_date, city,
       onboarded_by, updated_by, status, created_by, created_at, updated_at
FROM marketplace_pos;

DROP TABLE marketplace_pos;
ALTER TABLE marketplace_pos_new RENAME TO marketplace_pos;

UPDATE product_vendor_codes SET vendor = 'Scootsy' WHERE vendor = 'Swiggy';
