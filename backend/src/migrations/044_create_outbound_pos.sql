-- Outbound POs: orders placed to outbound vendors, with line items picked
-- from the vendor's configured article mappings. Line fields are denormalized
-- copies (not FKs to outbound_vendor_articles) so past POs survive vendor
-- config edits. Also adds the Companies master used by the PO header.

CREATE TABLE IF NOT EXISTS companies (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS outbound_pos (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  vendor_id  INTEGER NOT NULL REFERENCES outbound_vendors(id),
  company_id INTEGER REFERENCES companies(id),
  po_date    TEXT,
  status     TEXT NOT NULL DEFAULT 'Open'
    CHECK (status IN ('Open','Partially Received','Closed','Deleted')),
  created_by INTEGER NOT NULL REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS outbound_po_lines (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  po_id     INTEGER NOT NULL REFERENCES outbound_pos(id) ON DELETE CASCADE,
  line_no   INTEGER NOT NULL,
  category  TEXT NOT NULL,
  item_name TEXT NOT NULL,
  variant   TEXT,
  qty       INTEGER NOT NULL,
  rate      REAL NOT NULL DEFAULT 0,
  received  INTEGER NOT NULL DEFAULT 0,
  short     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_outbound_po_lines_po ON outbound_po_lines(po_id);
