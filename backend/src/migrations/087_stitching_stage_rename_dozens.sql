-- The chain loses Gray, renames its stages after the work being done, and
-- counts dozens from Stitching on.
--
-- What the business asked for, in the order this file answers it:
--
-- 1. GRAY IS GONE. Fabric is never booked in raw any more -- a receipt starts
--    at the first stage that actually works on it. The GRY prefix is deleted
--    and Gray leaves every CHECK. There were no Gray lots when this was
--    written, and the guard below makes that an assertion rather than a hope:
--    if a receipt or challan anywhere (live OR soft-deleted) still sits at
--    Gray, the whole migration rolls back before anything is touched.
--
-- 2. STAGES ARE NAMED FOR THE WORK, not the result. The stored values change,
--    not just the labels, because this codebase has no label map -- the
--    stored string IS what every tab, header, error message and export shows.
--
--      Processed -> Processing
--      Stitched  -> Stitching
--      Packed    -> Packing
--      Panchal and Third Party are unchanged
--
--    Three tables hold a stage and all three need a rebuild, because SQLite
--    cannot ALTER a CHECK. audit_logs is deliberately left alone -- it is
--    history, and history keeps the names that were current when it was written.
--
-- 3. DOZENS FROM STITCHING ON. Processing is the last stage that counts
--    metres. A challan leaving Processing records metres sent and dozens
--    received, which is where the conversion happens. A challan leaving any
--    later stage records dozens only. So:
--
--    - sent_qty and received_qty become NULLABLE. They stay the metre figures
--      and are only set on a challan whose parent is at Processing.
--    - sent_dozens arrives. It is what a challan (or a write-off) takes out
--      of a parent that counts dozens, and it is what that parent's balance
--      subtracts. received_dozens on the child equals it.
--    - Backfill: every existing challan whose parent counts dozens gets
--      sent_dozens = its own received_dozens (already required on every
--      dozen destination). A write-off has no dozens of its own, so its
--      metres are converted at the parent's yield and rounded to 2 places.
--
-- 4. ONE CHALLAN, SEVERAL LINE ITEMS. Each line (a Fresh line and a Second
--    line, say) is still its own row and therefore its own lot downstream,
--    because the grades travel separately. challan_line_no numbers them, and
--    the uniqueness from 085 widens from (challan_no, party_name) to
--    (challan_no, party_name, challan_line_no).
--
-- 5. RATES ARE PER DOZEN NOW, and belong to the stage being LEFT. The number
--    typed on a challan out of Processing is the Processing rate. Every
--    destination is now a dozen stage, so every new challan rate is per
--    dozen. Historical rows were entered under the old rule -- per dozen only
--    into Stitched or Packed, per metre otherwise -- and rate_unit records
--    which, so the per-dozen total converts them honestly instead of this
--    file rewriting the numbers.
--
-- 6. A RECEIPT BOOKED STRAIGHT INTO PANCHAL IS CLOSED. Panchal is the end of
--    the chain, so a receipt landing there has nothing left to happen to it.
--    The controller now closes one on save. Existing ones are closed here,
--    with closed_by left NULL because no person did it -- this migration did.
--
-- Order matters. stitching_entries is rebuilt FIRST, while the old prefix
-- table still exists for its incoming_prefix_id to point at. Then the prefix
-- table is rebuilt with the 081 detach-and-reattach, which now covers both
-- tables that reference it.
--
-- No semicolons may appear in these comments -- migrate.js splits on them.
PRAGMA defer_foreign_keys = ON;

-- THE GUARD. A single-row table whose CHECK only admits zero, fed the count of
-- everything still at Gray. Any Gray row makes this INSERT fail, which rolls the
-- migration back with the column name as the explanation.
CREATE TABLE _mig087_guard (gray_rows_must_be_zero INTEGER CHECK (gray_rows_must_be_zero = 0));

INSERT INTO _mig087_guard (gray_rows_must_be_zero)
  SELECT (SELECT COUNT(*) FROM outbound_po_line_receipts r
            JOIN stitching_prefixes p ON p.id = r.incoming_prefix_id
           WHERE p.stage = 'Gray')
       + (SELECT COUNT(*) FROM stitching_entries WHERE stage = 'Gray');

DROP TABLE _mig087_guard;

-- ---------------------------------------------------------------------------
-- stitching_entries
-- ---------------------------------------------------------------------------
CREATE TABLE stitching_entries_new (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  stage               TEXT NOT NULL CHECK (stage IN ('Processing','Stitching','Packing','Panchal','Third Party')),
  origin_receipt_id   INTEGER NOT NULL REFERENCES outbound_po_line_receipts(id),
  parent_receipt_id   INTEGER REFERENCES outbound_po_line_receipts(id),
  parent_entry_id     INTEGER REFERENCES stitching_entries_new(id),
  party_name          TEXT NOT NULL,
  party_id            INTEGER REFERENCES stitching_parties(id),
  outbound_bill_no    TEXT,
  challan_no          TEXT,
  challan_line_no     INTEGER NOT NULL DEFAULT 1,
  challan_type        TEXT CHECK (challan_type IS NULL OR challan_type IN ('Fresh','Second','Third')),
  incoming_prefix_id  INTEGER REFERENCES stitching_prefixes(id),
  incoming_no         TEXT,
  panchal_incoming_no TEXT,
  sent_qty            REAL,
  received_qty        REAL,
  sent_dozens         REAL,
  received_dozens     REAL,
  process_rate        REAL,
  rate_unit           TEXT CHECK (rate_unit IS NULL OR rate_unit IN ('metre','dozen')),
  after_rate          REAL,
  checked_by          INTEGER REFERENCES users(id),
  closed_at           TEXT,
  closed_by           INTEGER REFERENCES users(id),
  revert_reason       TEXT,
  received_at         TEXT,
  received_by         INTEGER REFERENCES users(id),
  write_off_reason    TEXT,
  created_by          INTEGER REFERENCES users(id),
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by          INTEGER REFERENCES users(id),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_by          INTEGER REFERENCES users(id),
  deleted_at          TEXT,
  CHECK ((parent_receipt_id IS NULL) <> (parent_entry_id IS NULL))
);

INSERT INTO stitching_entries_new
  (id, stage, origin_receipt_id, parent_receipt_id, parent_entry_id, party_name, party_id,
   outbound_bill_no, challan_no, challan_line_no, challan_type, incoming_prefix_id, incoming_no,
   panchal_incoming_no, sent_qty, received_qty, sent_dozens, received_dozens,
   process_rate, rate_unit, after_rate, checked_by, closed_at, closed_by,
   revert_reason, received_at, received_by, write_off_reason,
   created_by, created_at, updated_by, updated_at, deleted_by, deleted_at)
  SELECT e.id,
         CASE e.stage WHEN 'Processed' THEN 'Processing'
                      WHEN 'Stitched'  THEN 'Stitching'
                      WHEN 'Packed'    THEN 'Packing'
                      ELSE e.stage END,
         e.origin_receipt_id, e.parent_receipt_id, e.parent_entry_id, e.party_name, e.party_id,
         e.outbound_bill_no, e.challan_no, 1, e.challan_type, e.incoming_prefix_id, e.incoming_no,
         e.panchal_incoming_no, e.sent_qty, e.received_qty,
         -- sent_dozens, only where the PARENT counts dozens. The parent's stage
         -- is read under its OLD name because the rows being read are the old ones.
         CASE WHEN COALESCE(pe.stage, psp.stage) IN ('Stitched','Packed','Panchal','Third Party')
              THEN COALESCE(
                     CASE WHEN e.write_off_reason IS NULL THEN e.received_dozens END,
                     CASE WHEN COALESCE(pe.received_qty, pr.qty_in_metres) > 0
                          THEN ROUND(e.sent_qty * COALESCE(pe.received_dozens, pr.received_dozens)
                                     / COALESCE(pe.received_qty, pr.qty_in_metres), 2) END)
         END,
         e.received_dozens,
         e.process_rate,
         CASE WHEN e.process_rate IS NULL THEN NULL
              WHEN e.stage IN ('Stitched','Packed') THEN 'dozen'
              ELSE 'metre' END,
         e.after_rate, e.checked_by, e.closed_at, e.closed_by,
         e.revert_reason, e.received_at, e.received_by, e.write_off_reason,
         e.created_by, e.created_at, e.updated_by, e.updated_at, e.deleted_by, e.deleted_at
    FROM stitching_entries e
    LEFT JOIN stitching_entries pe ON pe.id = e.parent_entry_id
    LEFT JOIN outbound_po_line_receipts pr ON pr.id = e.parent_receipt_id
    LEFT JOIN stitching_prefixes psp ON psp.id = pr.incoming_prefix_id;

-- The 082 trick. Nothing outside this table points at it, so an explicit DELETE
-- resolves every self-reference violation it raises before COMMIT, and DROP on
-- an empty table performs no implicit delete.
DELETE FROM stitching_entries;
DROP TABLE stitching_entries;
ALTER TABLE stitching_entries_new RENAME TO stitching_entries;

CREATE INDEX IF NOT EXISTS idx_stitching_entries_parent_receipt ON stitching_entries(parent_receipt_id);
CREATE INDEX IF NOT EXISTS idx_stitching_entries_parent_entry ON stitching_entries(parent_entry_id);
CREATE INDEX IF NOT EXISTS idx_stitching_entries_origin ON stitching_entries(origin_receipt_id);
CREATE INDEX IF NOT EXISTS idx_stitching_entries_stage ON stitching_entries(stage);
-- 085 widened by the line number, so one challan can carry several lines.
CREATE UNIQUE INDEX IF NOT EXISTS idx_stitching_challan_party
  ON stitching_entries(challan_no, party_name, challan_line_no)
  WHERE deleted_at IS NULL AND challan_no IS NOT NULL;

-- ---------------------------------------------------------------------------
-- stitching_prefixes -- the 081 detach-and-reattach, over both referencing tables
-- ---------------------------------------------------------------------------
CREATE TABLE stitching_prefix_fk_backup (
  src       TEXT NOT NULL,
  row_id    INTEGER NOT NULL,
  prefix_id INTEGER NOT NULL
);

INSERT INTO stitching_prefix_fk_backup (src, row_id, prefix_id)
  SELECT 'receipt', id, incoming_prefix_id FROM outbound_po_line_receipts
   WHERE incoming_prefix_id IS NOT NULL;
INSERT INTO stitching_prefix_fk_backup (src, row_id, prefix_id)
  SELECT 'entry', id, incoming_prefix_id FROM stitching_entries
   WHERE incoming_prefix_id IS NOT NULL;

UPDATE outbound_po_line_receipts SET incoming_prefix_id = NULL WHERE incoming_prefix_id IS NOT NULL;
UPDATE stitching_entries SET incoming_prefix_id = NULL WHERE incoming_prefix_id IS NOT NULL;

CREATE TABLE stitching_prefixes_new (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  prefix     TEXT NOT NULL UNIQUE COLLATE NOCASE,
  stage      TEXT NOT NULL CHECK (stage IN ('Processing','Stitching','Packing','Panchal')),
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Gray prefixes are simply not copied. The guard above has already proved
-- nothing points at them.
INSERT INTO stitching_prefixes_new (id, prefix, stage, is_active, created_at, updated_by, updated_at)
  SELECT id, prefix,
         CASE stage WHEN 'Processed' THEN 'Processing'
                    WHEN 'Stitched'  THEN 'Stitching'
                    WHEN 'Packed'    THEN 'Packing'
                    ELSE stage END,
         is_active, created_at, updated_by, updated_at
    FROM stitching_prefixes
   WHERE stage <> 'Gray';

DROP TABLE stitching_prefixes;
ALTER TABLE stitching_prefixes_new RENAME TO stitching_prefixes;
CREATE INDEX IF NOT EXISTS idx_stitching_prefixes_stage ON stitching_prefixes(stage);

UPDATE outbound_po_line_receipts
   SET incoming_prefix_id = (SELECT b.prefix_id FROM stitching_prefix_fk_backup b
                              WHERE b.src = 'receipt' AND b.row_id = outbound_po_line_receipts.id)
 WHERE id IN (SELECT row_id FROM stitching_prefix_fk_backup WHERE src = 'receipt');
UPDATE stitching_entries
   SET incoming_prefix_id = (SELECT b.prefix_id FROM stitching_prefix_fk_backup b
                              WHERE b.src = 'entry' AND b.row_id = stitching_entries.id)
 WHERE id IN (SELECT row_id FROM stitching_prefix_fk_backup WHERE src = 'entry');

DROP TABLE stitching_prefix_fk_backup;

-- ---------------------------------------------------------------------------
-- stitching_party_uses -- nothing references it, so a plain rebuild
-- ---------------------------------------------------------------------------
CREATE TABLE stitching_party_uses_new (
  party_id  INTEGER NOT NULL REFERENCES stitching_parties(id) ON DELETE CASCADE,
  use_stage TEXT NOT NULL CHECK (use_stage IN ('Processing','Stitching','Packing','Panchal','Third Party')),
  PRIMARY KEY (party_id, use_stage)
);

INSERT INTO stitching_party_uses_new (party_id, use_stage)
  SELECT party_id,
         CASE use_stage WHEN 'Processed' THEN 'Processing'
                        WHEN 'Stitched'  THEN 'Stitching'
                        WHEN 'Packed'    THEN 'Packing'
                        ELSE use_stage END
    FROM stitching_party_uses;

DROP TABLE stitching_party_uses;
ALTER TABLE stitching_party_uses_new RENAME TO stitching_party_uses;
CREATE INDEX IF NOT EXISTS idx_stitching_party_uses_stage ON stitching_party_uses(use_stage);

-- ---------------------------------------------------------------------------
-- A party's short name, for the "Stitching - SKT" tags on the Stitching page.
-- Optional -- blank falls back to the party's initials.
-- ---------------------------------------------------------------------------
ALTER TABLE stitching_parties ADD COLUMN short_name TEXT;

-- ---------------------------------------------------------------------------
-- Receipts booked STRAIGHT INTO Panchal from a PO are closed, as a new one now
-- is on save. Only outbound_po_line_receipts is touched -- a lot that reached
-- Panchal by challan lives in stitching_entries and keeps the ordinary flow,
-- In Stock until someone closes it.
-- ---------------------------------------------------------------------------
UPDATE outbound_po_line_receipts
   SET closed_at = datetime('now')
 WHERE closed_at IS NULL
   AND deleted_at IS NULL
   AND incoming_prefix_id IN (SELECT id FROM stitching_prefixes WHERE stage = 'Panchal')
