-- WAREHOUSES BECOME DATA. Panchal stops being a stage and becomes the first row
-- of a warehouses master, and the stage it sat at is renamed Warehouse.
--
-- Why: the client is opening a second warehouse that works exactly like
-- Panchal -- stock lands there by challan or straight off a PO, sits In Stock
-- until closed, and is never forwarded on. More may follow, and an existing one
-- may be renamed. With Panchal written into three CHECKs and both stitching
-- service twins, every new warehouse would have been a migration and a release,
-- and a rename another 087. After this file all three are an admin action in
-- Purchase Config.
--
-- The model, in the order this file builds it:
--
-- 1. warehouses -- id, name, code, is_active, the shape of every config master.
--    name is what the tab, the destination tile and every label show. code is
--    the short form the warehouse's own incoming number is printed under (the
--    "PCL" in "PCL Inc No"). Both UNIQUE NOCASE. Delete means deactivate.
--    Seeded with Panchal / PCL.
--
-- 2. ONE STAGE, Warehouse, replaces Panchal in every CHECK. It is the ROLE --
--    the end of the chain where stock sits -- and every rule that keyed on
--    Panchal (In Stock until closed, graded, dozens, a Warehouse POC checker,
--    closed on save when booked straight in) keys on it unchanged.
--
-- 3. WHICH warehouse a lot is in is DERIVED, never stored on the lot. Each
--    Warehouse prefix belongs to exactly one warehouse (stitching_prefixes gets
--    warehouse_id, set if and only if the stage is Warehouse), and every lot
--    already points at its prefix. So a lot's warehouse can never disagree with
--    the incoming number printed on it, and renaming a warehouse touches one
--    row. PNL is assigned to Panchal here.
--
-- 4. panchal_incoming_no becomes warehouse_incoming_no. Same value, the
--    warehouse's own gate number for a lot sent to it -- named for the role now
--    that more than one warehouse keeps one.
--
-- Three tables hold the stage and all three are rebuilt, because SQLite cannot
-- ALTER a CHECK. This is 087 over the same three tables, in the same order and
-- for the same reasons: stitching_entries first (self-referencing, so the 082
-- trick), then stitching_prefixes (referenced by receipts and entries, so the
-- 081 detach-and-reattach), then stitching_party_uses (a plain rebuild).
-- audit_logs is left alone -- history keeps the names that were current when it
-- was written.
--
-- Old code writes Panchal and fails the new CHECK, and new code expects
-- Warehouse, so this file and the code that reads it ship together.
--
-- No semicolons may appear in these comments -- migrate.js splits on them.
PRAGMA defer_foreign_keys = ON;

-- THE GUARD, the 087 pattern. A warehouse lot finds its warehouse through its
-- prefix, so a Panchal lot with no prefix would land in no warehouse at all --
-- on no tab, counted nowhere. Every challan since prefixes existed was numbered
-- under one, so there should be none, and this makes that an assertion rather
-- than a hope: any such row (live OR soft-deleted, since a restore would bring
-- it back) fails this INSERT and rolls the whole file back untouched. Write-offs
-- carry no prefix by design and are not lots, so they are not counted.
CREATE TABLE _mig096_guard (unprefixed_panchal_lots_must_be_zero INTEGER CHECK (unprefixed_panchal_lots_must_be_zero = 0));

INSERT INTO _mig096_guard (unprefixed_panchal_lots_must_be_zero)
  SELECT COUNT(*) FROM stitching_entries
   WHERE stage = 'Panchal' AND incoming_prefix_id IS NULL AND write_off_reason IS NULL;

DROP TABLE _mig096_guard;

-- ---------------------------------------------------------------------------
-- warehouses
-- ---------------------------------------------------------------------------
CREATE TABLE warehouses (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  code       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO warehouses (name, code) VALUES ('Panchal', 'PCL');

-- ---------------------------------------------------------------------------
-- stitching_entries -- Panchal becomes Warehouse, and the warehouse's own
-- incoming number takes the role's name
-- ---------------------------------------------------------------------------
CREATE TABLE stitching_entries_new (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  stage                 TEXT NOT NULL CHECK (stage IN ('Processing','Stitching','Packing','Warehouse','Third Party')),
  origin_receipt_id     INTEGER NOT NULL REFERENCES outbound_po_line_receipts(id),
  parent_receipt_id     INTEGER REFERENCES outbound_po_line_receipts(id),
  parent_entry_id       INTEGER REFERENCES stitching_entries_new(id),
  party_name            TEXT NOT NULL,
  outbound_bill_no      TEXT,
  challan_no            TEXT,
  challan_line_no       INTEGER NOT NULL DEFAULT 1,
  challan_type          TEXT CHECK (challan_type IS NULL OR challan_type IN ('Fresh','Second','Third')),
  incoming_prefix_id    INTEGER REFERENCES stitching_prefixes(id),
  incoming_no           TEXT,
  warehouse_incoming_no TEXT,
  sent_qty              REAL,
  received_qty          REAL,
  sent_dozens           REAL,
  received_dozens       REAL,
  process_rate          REAL,
  rate_unit             TEXT CHECK (rate_unit IS NULL OR rate_unit IN ('metre','dozen')),
  checked_by            INTEGER REFERENCES users(id),
  closed_at             TEXT,
  closed_by             INTEGER REFERENCES users(id),
  revert_reason         TEXT,
  write_off_reason      TEXT,
  created_by            INTEGER REFERENCES users(id),
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by            INTEGER REFERENCES users(id),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_by            INTEGER REFERENCES users(id),
  deleted_at            TEXT,
  stage_party_name      TEXT,
  stage_rate            REAL,
  fresh_dozens          REAL NOT NULL DEFAULT 0,
  second_dozens         REAL NOT NULL DEFAULT 0,
  third_dozens          REAL NOT NULL DEFAULT 0,
  CHECK ((parent_receipt_id IS NULL) <> (parent_entry_id IS NULL))
);

INSERT INTO stitching_entries_new
  (id, stage, origin_receipt_id, parent_receipt_id, parent_entry_id, party_name,
   outbound_bill_no, challan_no, challan_line_no, challan_type, incoming_prefix_id, incoming_no,
   warehouse_incoming_no, sent_qty, received_qty, sent_dozens, received_dozens,
   process_rate, rate_unit, checked_by, closed_at, closed_by, revert_reason, write_off_reason,
   created_by, created_at, updated_by, updated_at, deleted_by, deleted_at,
   stage_party_name, stage_rate, fresh_dozens, second_dozens, third_dozens)
  SELECT id,
         CASE stage WHEN 'Panchal' THEN 'Warehouse' ELSE stage END,
         origin_receipt_id, parent_receipt_id, parent_entry_id, party_name,
         outbound_bill_no, challan_no, challan_line_no, challan_type, incoming_prefix_id, incoming_no,
         panchal_incoming_no, sent_qty, received_qty, sent_dozens, received_dozens,
         process_rate, rate_unit, checked_by, closed_at, closed_by, revert_reason, write_off_reason,
         created_by, created_at, updated_by, updated_at, deleted_by, deleted_at,
         stage_party_name, stage_rate, fresh_dozens, second_dozens, third_dozens
    FROM stitching_entries;

-- The 082 trick, as 087 used it. Nothing outside this table points at it, so an
-- explicit DELETE resolves every self-reference violation it raises before
-- COMMIT, and DROP on an empty table performs no implicit delete.
DELETE FROM stitching_entries;
DROP TABLE stitching_entries;
ALTER TABLE stitching_entries_new RENAME TO stitching_entries;

CREATE INDEX IF NOT EXISTS idx_stitching_entries_parent_receipt ON stitching_entries(parent_receipt_id);
CREATE INDEX IF NOT EXISTS idx_stitching_entries_parent_entry ON stitching_entries(parent_entry_id);
CREATE INDEX IF NOT EXISTS idx_stitching_entries_origin ON stitching_entries(origin_receipt_id);
CREATE INDEX IF NOT EXISTS idx_stitching_entries_stage ON stitching_entries(stage);
CREATE UNIQUE INDEX IF NOT EXISTS idx_stitching_challan_party
  ON stitching_entries(challan_no, party_name, challan_line_no)
  WHERE deleted_at IS NULL AND challan_no IS NOT NULL;

-- ---------------------------------------------------------------------------
-- stitching_prefixes -- the 081 detach-and-reattach over both referencing
-- tables, with each Warehouse prefix now naming its warehouse
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

-- warehouse_id is set exactly when the stage is Warehouse. A Warehouse prefix
-- with no warehouse would number goods into nowhere, and a warehouse on any
-- other stage's prefix would mean nothing.
CREATE TABLE stitching_prefixes_new (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  prefix       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  stage        TEXT NOT NULL CHECK (stage IN ('Processing','Stitching','Packing','Warehouse')),
  warehouse_id INTEGER REFERENCES warehouses(id),
  is_active    INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by   INTEGER REFERENCES users(id),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((stage = 'Warehouse') = (warehouse_id IS NOT NULL))
);

-- Every Panchal prefix (PNL, and any an admin added beside it) belongs to Panchal.
INSERT INTO stitching_prefixes_new (id, prefix, stage, warehouse_id, is_active, created_at, updated_by, updated_at)
  SELECT id, prefix,
         CASE stage WHEN 'Panchal' THEN 'Warehouse' ELSE stage END,
         CASE stage WHEN 'Panchal' THEN (SELECT id FROM warehouses WHERE name = 'Panchal') END,
         is_active, created_at, updated_by, updated_at
    FROM stitching_prefixes;

DROP TABLE stitching_prefixes;
ALTER TABLE stitching_prefixes_new RENAME TO stitching_prefixes;
CREATE INDEX IF NOT EXISTS idx_stitching_prefixes_stage ON stitching_prefixes(stage);
CREATE INDEX IF NOT EXISTS idx_stitching_prefixes_warehouse ON stitching_prefixes(warehouse_id);

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
-- stitching_party_uses -- nothing references it, so a plain rebuild. One
-- Warehouse tag covers every warehouse.
-- ---------------------------------------------------------------------------
CREATE TABLE stitching_party_uses_new (
  party_id  INTEGER NOT NULL REFERENCES stitching_parties(id) ON DELETE CASCADE,
  use_stage TEXT NOT NULL CHECK (use_stage IN ('Processing','Stitching','Packing','Warehouse','Third Party')),
  PRIMARY KEY (party_id, use_stage)
);

INSERT INTO stitching_party_uses_new (party_id, use_stage)
  SELECT party_id, CASE use_stage WHEN 'Panchal' THEN 'Warehouse' ELSE use_stage END
    FROM stitching_party_uses;

DROP TABLE stitching_party_uses;
ALTER TABLE stitching_party_uses_new RENAME TO stitching_party_uses;
CREATE INDEX IF NOT EXISTS idx_stitching_party_uses_stage ON stitching_party_uses(use_stage)
