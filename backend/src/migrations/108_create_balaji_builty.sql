-- BALAJI BUILTY (client, 2026-11-28).
--
-- The Builty page is a VIEW over marketplace_pos: Order Date, Vendor, PO No.,
-- Quantity, City, Expiry, Dispatch, Courier and Tracking all come from an
-- imported PO and the Order Summary, and only Party Name, Bill no and Bill
-- Date are typed there. Balaji Builty is the same sheet for goods that never
-- came in as a marketplace PO, so there is nothing to read the columns from --
-- staff type every one of them. Its own table, not rows in marketplace_pos:
-- a hand-kept builty has no lines, no POC, no GRN and no RTV, and putting it
-- among the POs would drag it into every one of those pages.
--
-- THE ID. po_id is the primary key, P plus a serial padded to three digits
-- (P001, P002 ... P999, P1000), minted by the controller inside the insert's
-- transaction as one more than the highest serial ever used -- deleted rows
-- included, so a number is never handed out twice and an audit trail never
-- belongs to two entries. The CHECK pins the shape. The vendors controller
-- reserves P as a PO prefix so a marketplace vendor cannot mint a second P001.
--
-- FREE TEXT, ALL OF IT (client's choice). Vendor, City and Courier are typed,
-- not picked from the vendors, cities and couriers masters, so they are TEXT
-- here rather than ids. The page suggests values already used, which keeps the
-- spelling steady without refusing a new one. Vendor is the one required field
-- because the page's tabs are its distinct vendors, compared ignoring case --
-- hence the NOCASE index.
--
-- BILL NO is unique among live entries only (client's choice: not checked
-- against the marketplace POs' bill numbers). The partial UNIQUE index skips
-- NULLs and deleted rows, so deleting an entry frees its number. Its format
-- is the Builty rule in services/billNo.js.
--
-- SOFT DELETE. deleted_at and deleted_by, as on the outbound tables. Nothing
-- reads a deleted row except the id counter.
--
-- Additive: a new table nothing else reads, so this file goes AHEAD of the
-- deploy.
--
-- No semicolons may appear in these comments -- migrate.js splits on them.

CREATE TABLE IF NOT EXISTS balaji_builty (
  po_id          TEXT PRIMARY KEY CHECK (po_id GLOB 'P[0-9][0-9][0-9]*'),
  po_date        TEXT,
  vendor         TEXT NOT NULL CHECK (TRIM(vendor) <> ''),
  party_name     TEXT,
  vendor_po_id   TEXT,
  qty            INTEGER CHECK (qty IS NULL OR qty >= 0),
  city           TEXT,
  expiry_date    TEXT,
  dispatch_date  TEXT,
  courier        TEXT,
  tracking_id    TEXT,
  bill_no        TEXT,
  bill_date      TEXT,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at     TEXT,
  deleted_by     INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_balaji_builty_bill_no
  ON balaji_builty(bill_no) WHERE bill_no IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_balaji_builty_vendor
  ON balaji_builty(vendor COLLATE NOCASE)
