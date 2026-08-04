-- New receipts sub-ledger: one row per delivery/bill against a PO line.
-- A single line can now be received against multiple bills, each with its
-- own qty/rate/bill number. Line.received becomes a computed SUM of active
-- receipts (see controller). Line.short stays a single running number.
CREATE TABLE IF NOT EXISTS outbound_po_line_receipts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  line_id        INTEGER NOT NULL REFERENCES outbound_po_lines(id) ON DELETE CASCADE,
  received_qty   REAL NOT NULL,
  received_rate  REAL,
  bill_no        TEXT,
  created_by     INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by     INTEGER REFERENCES users(id),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_by     INTEGER REFERENCES users(id),
  deleted_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbound_po_line_receipts_line ON outbound_po_line_receipts(line_id);

-- outbound_po_lines.qty and .short stay declared INTEGER (no rebuild needed)
-- SQLite's type affinity stores a non-integer numeric value in an
-- INTEGER-affinity column as REAL without truncation, so decimal quantities
-- (e.g. fabric measured in meters/kg) round-trip correctly at the storage
-- layer already. Only application-level validation changes (see controller).

-- Per-line audit/soft-delete metadata, mirroring the updated_by/updated_at
-- convention added in migration 029. Nullable, no backfill needed for these.
ALTER TABLE outbound_po_lines ADD COLUMN updated_by INTEGER REFERENCES users(id);
ALTER TABLE outbound_po_lines ADD COLUMN updated_at TEXT;
ALTER TABLE outbound_po_lines ADD COLUMN deleted_by INTEGER REFERENCES users(id);
ALTER TABLE outbound_po_lines ADD COLUMN deleted_at TEXT;

-- Backfill: every existing line's flat `received` value becomes one receipt
-- row, so SUM(receipts) reproduces today's numbers exactly. received_rate and
-- bill_no are left NULL since no historical rate/bill was ever captured --
-- inventing one would misrepresent real data. outbound_po_lines.received
-- itself is left in place (unused going forward) rather than dropped, per
-- the non-destructive-migration convention.
INSERT INTO outbound_po_line_receipts (line_id, received_qty, received_rate, bill_no, created_by, created_at, updated_by, updated_at)
SELECT l.id, l.received, NULL, NULL, p.updated_by, p.updated_at, p.updated_by, p.updated_at
FROM outbound_po_lines l
JOIN outbound_pos p ON p.id = l.po_id
WHERE l.received > 0
