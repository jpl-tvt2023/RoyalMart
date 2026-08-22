-- incoming_no becomes TEXT.
--
-- Migration 058 declared it INTEGER on the reading that a gate register number
-- is "a whole number". The real warehouse register uses alphanumeric ids
-- (IN-4521, A/2026/0077), so the app now accepts free text.
--
-- A rebuild is genuinely required rather than merely tidy. SQLite affinity
-- would already store 'IN-4521' verbatim in an INTEGER-affinity column, but it
-- coerces an all-digit value losslessly to an integer -- so '0077' would come
-- back as 77 and the leading zeros the register actually uses would be gone.
-- TEXT affinity is the only way to round-trip what was typed.
--
-- Compare migration 053, which deliberately did NOT rebuild for
-- outbound_po_lines.qty: affinity carries a decimal into an INTEGER column
-- without truncation, so validation alone was enough there. It is not enough
-- here.
--
-- SAFETY -- no table declares REFERENCES outbound_po_line_receipts, so the
-- DROP below cascades to nothing. The table's own five outbound foreign keys
-- are restated verbatim. Row ids are carried across unchanged so audit_logs
-- descriptions still name the right receipts, and
-- idx_outbound_po_line_receipts_line is recreated because indexes do not
-- survive a rebuild.
CREATE TABLE outbound_po_line_receipts_new (
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
  deleted_at     TEXT,
  checked_by     INTEGER REFERENCES users(id),
  incoming_no    TEXT
);

-- CAST(NULL AS TEXT) is NULL, so receipts recorded without an incoming number
-- stay NULL and keep raising the missing_incoming_no flag.
INSERT INTO outbound_po_line_receipts_new
  (id, line_id, received_qty, received_rate, bill_no, created_by, created_at,
   updated_by, updated_at, deleted_by, deleted_at, checked_by, incoming_no)
SELECT id, line_id, received_qty, received_rate, bill_no, created_by, created_at,
       updated_by, updated_at, deleted_by, deleted_at, checked_by,
       CAST(incoming_no AS TEXT)
FROM outbound_po_line_receipts;

DROP TABLE outbound_po_line_receipts;

ALTER TABLE outbound_po_line_receipts_new RENAME TO outbound_po_line_receipts;

CREATE INDEX IF NOT EXISTS idx_outbound_po_line_receipts_line
  ON outbound_po_line_receipts(line_id)
