-- Outbound vendors: recipients of goods going out, distinct from the
-- inbound `vendors` master (which carries has_parser and marketplace-PO
-- specific logic that doesn't apply here). Each vendor can declare
-- multiple Category / Item Name / Variant combinations it can receive.

CREATE TABLE IF NOT EXISTS outbound_vendors (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS outbound_vendor_articles (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  vendor_id  INTEGER NOT NULL REFERENCES outbound_vendors(id) ON DELETE CASCADE,
  category   TEXT NOT NULL CHECK (category IN ('Raw Material','Packaging','Others')),
  item_name  TEXT NOT NULL,
  variant    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_outbound_vendor_articles_vendor
  ON outbound_vendor_articles(vendor_id);
