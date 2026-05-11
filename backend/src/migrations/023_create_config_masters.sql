-- Config masters: cities and vendors. Both seeded from previously hardcoded
-- values. The marketplace_pos table currently CHECK-constrains the vendor
-- column to the three hardcoded names, which would block any vendor an admin
-- adds via the new Configurations page. SQLite cannot ALTER a CHECK
-- constraint, so we rebuild the table without the constraint.

CREATE TABLE IF NOT EXISTS cities (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS vendors (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  is_active  INTEGER NOT NULL DEFAULT 1,
  has_parser INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO vendors (name, has_parser) VALUES ('Scootsy', 1);
INSERT INTO vendors (name, has_parser) VALUES ('Zepto', 1);
INSERT INTO vendors (name, has_parser) VALUES ('Blinkit', 1);

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
  status                 TEXT NOT NULL DEFAULT 'Open' CHECK (status IN ('Open','Closed')),
  office_poc             INTEGER REFERENCES users(id),
  warehouse_poc          INTEGER REFERENCES users(id),
  dispatch_date          TEXT,
  courier_id             INTEGER REFERENCES couriers(id),
  tracking_id            TEXT,
  created_by             INTEGER NOT NULL REFERENCES users(id),
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (vendor, vendor_po_id)
);

INSERT INTO marketplace_pos_new
  (po_id, vendor, vendor_po_id, po_date, expected_delivery_date, po_expiry_date, city,
   onboarded_by, updated_by, status, office_poc, warehouse_poc, dispatch_date,
   courier_id, tracking_id, created_by, created_at, updated_at)
SELECT po_id, vendor, vendor_po_id, po_date, expected_delivery_date, po_expiry_date, city,
       onboarded_by, updated_by, status, office_poc, warehouse_poc, dispatch_date,
       courier_id, tracking_id, created_by, created_at, updated_at
FROM marketplace_pos;

DROP TABLE marketplace_pos;

ALTER TABLE marketplace_pos_new RENAME TO marketplace_pos;

CREATE INDEX IF NOT EXISTS idx_marketplace_pos_tracking_id
  ON marketplace_pos(tracking_id) WHERE tracking_id IS NOT NULL;
