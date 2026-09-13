-- The chain stops being a line and becomes a graph.
--
-- Gray to Processed to Stitched to Packed was a single file, which is why
-- nextStage(parent.stage) could be the only answer and the user never picked a
-- destination. That is no longer what happens. From Processed onward material
-- branches: on to the next stage, straight past it, into the warehouse, or out
-- of the business entirely against an outbound bill.
--
--   Gray        -> Processed
--   Processed   -> Stitched, Packed, Panchal, Third Party
--   Stitched    -> Packed, Panchal, Third Party
--   Packed      -> Panchal, Third Party
--   Panchal     -> nothing. It is the warehouse, and what sits there is stock
--   Third Party -> nothing. The goods left
--
-- DESTINATIONS in stitching.service.js is the live twin of that table and the
-- single source of truth the API validates against. This CHECK only has to
-- admit the six values -- which stage may reach which is not expressible here.
--
-- Four changes, one rebuild. A rebuild is the expensive part (create, copy,
-- drop, rename, then recreate every index by hand because indexes do not
-- survive it), so everything that needs one is done at once:
--
-- 1. stage widens to six values, admitting Panchal and Third Party.
--
-- 2. challan_type gets the CHECK migration 080 deliberately deferred. 080 could
--    only ADD COLUMN, and SQLite will not attach a CHECK that way. Rows written
--    between 080 and here were validated by the controller alone, which is why
--    this is a plain CHECK and not a NOT NULL: the rows predating 080 have no
--    type and inventing one for them would be a lie.
--
-- 3. bill_no becomes outbound_bill_no. The column has existed unused since 069
--    -- the challan form's own comment reads "There is no Bill No here. A challan
--    is not a bill." That is still true of a challan. It is NOT true of a
--    dispatch to a third party, which is a sale and carries our outbound bill
--    number. Renaming an unread column costs nothing during a rebuild and the
--    name now means something. Required when the destination is Third Party and
--    rejected everywhere else, enforced in validateEntryFields.
--
-- 4. party_id arrives, exactly as 069 said it would: "the user has said a party
--    master may come later -- when it does, add party_id and backfill against
--    this column." Migration 079 is that master. party_name STAYS as the
--    denormalised display copy so a challan keeps the spelling it was raised
--    under even if the master is renamed later -- the same trade
--    outbound_po_lines makes with its article fields.
-- stitching_entries REFERENCES ITSELF, through parent_entry_id, so the same
-- trap 081 documents applies here in a milder form: DROP TABLE performs an
-- implicit DELETE FROM, and every row that is a parent of another row becomes a
-- foreign key violation on the way out.
--
-- Here deferring genuinely does work, because nothing outside this table points
-- at it. An explicit DELETE removes every row, so each violation raised by
-- deleting a parent is resolved moments later by deleting the child that caused
-- it, and the counter is back to zero long before COMMIT. The rows have already
-- been copied into _new by then, so nothing is lost -- and DROP TABLE on an
-- empty table performs no implicit delete at all.
--
-- 081 could not use this trick: its children live in other tables and survive
-- the migration, so they had to be detached and reattached instead.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE stitching_entries_new (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  stage              TEXT NOT NULL CHECK (stage IN ('Gray','Processed','Stitched','Packed','Panchal','Third Party')),
  origin_receipt_id  INTEGER NOT NULL REFERENCES outbound_po_line_receipts(id),
  parent_receipt_id  INTEGER REFERENCES outbound_po_line_receipts(id),
  -- Points at stitching_entries_new, NOT at stitching_entries. A self-reference
  -- written against the old name would make every copied row a foreign key
  -- violation the moment the old table is emptied, and those violations are
  -- never cleared by the later rename -- which is the same counter behaviour 081
  -- documents. SQLite rewrites this clause to the final name during the RENAME
  -- below, so the table ends up self-referencing exactly as 069 declared it.
  parent_entry_id    INTEGER REFERENCES stitching_entries_new(id),
  party_name         TEXT NOT NULL,
  party_id           INTEGER REFERENCES stitching_parties(id),
  outbound_bill_no   TEXT,
  challan_no         TEXT,
  challan_type       TEXT CHECK (challan_type IS NULL OR challan_type IN ('Fresh','Second','Third')),
  incoming_prefix_id INTEGER REFERENCES stitching_prefixes(id),
  incoming_no        TEXT,
  sent_qty           REAL NOT NULL,
  received_qty       REAL NOT NULL,
  process_rate       REAL,
  after_rate         REAL,
  checked_by         INTEGER REFERENCES users(id),
  closed_at          TEXT,
  closed_by          INTEGER REFERENCES users(id),
  revert_reason      TEXT,
  received_at        TEXT,
  received_by        INTEGER REFERENCES users(id),
  write_off_reason   TEXT,
  created_by         INTEGER REFERENCES users(id),
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by         INTEGER REFERENCES users(id),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_by         INTEGER REFERENCES users(id),
  deleted_at         TEXT,
  CHECK ((parent_receipt_id IS NULL) <> (parent_entry_id IS NULL))
);

-- Ids carried across verbatim so audit_logs stays attached to the same rows.
-- party_id is resolved here rather than left for a later pass, so every row that
-- CAN point at the master does from the moment this lands. NOCASE because the
-- old free text was typed by hand and "Sharma" and "sharma" are one party.
INSERT INTO stitching_entries_new
  (id, stage, origin_receipt_id, parent_receipt_id, parent_entry_id, party_name, party_id,
   outbound_bill_no, challan_no, challan_type, incoming_prefix_id, incoming_no,
   sent_qty, received_qty, process_rate, after_rate, checked_by, closed_at, closed_by,
   revert_reason, received_at, received_by, write_off_reason,
   created_by, created_at, updated_by, updated_at, deleted_by, deleted_at)
  SELECT e.id, e.stage, e.origin_receipt_id, e.parent_receipt_id, e.parent_entry_id, e.party_name,
         (SELECT p.id FROM stitching_parties p WHERE p.name = e.party_name COLLATE NOCASE),
         e.bill_no, e.challan_no, e.challan_type, e.incoming_prefix_id, e.incoming_no,
         e.sent_qty, e.received_qty, e.process_rate, e.after_rate, e.checked_by, e.closed_at, e.closed_by,
         e.revert_reason, e.received_at, e.received_by, e.write_off_reason,
         e.created_by, e.created_at, e.updated_by, e.updated_at, e.deleted_by, e.deleted_at
    FROM stitching_entries e;

DELETE FROM stitching_entries;

DROP TABLE stitching_entries;

ALTER TABLE stitching_entries_new RENAME TO stitching_entries;

-- All six indexes recreated by hand: the four from 069 and the two partial
-- unique challan indexes from 073. None of them survive a rebuild, and losing
-- the 073 pair silently would let one lot carry two live challans with the same
-- number -- the exact thing it exists to stop.
CREATE INDEX IF NOT EXISTS idx_stitching_entries_parent_receipt ON stitching_entries(parent_receipt_id);

CREATE INDEX IF NOT EXISTS idx_stitching_entries_parent_entry ON stitching_entries(parent_entry_id);

CREATE INDEX IF NOT EXISTS idx_stitching_entries_origin ON stitching_entries(origin_receipt_id);

CREATE INDEX IF NOT EXISTS idx_stitching_entries_stage ON stitching_entries(stage);

CREATE UNIQUE INDEX IF NOT EXISTS idx_stitching_challan_per_receipt
  ON stitching_entries(parent_receipt_id, challan_no)
  WHERE deleted_at IS NULL AND parent_receipt_id IS NOT NULL AND challan_no IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_stitching_challan_per_entry
  ON stitching_entries(parent_entry_id, challan_no)
  WHERE deleted_at IS NULL AND parent_entry_id IS NOT NULL AND challan_no IS NOT NULL
