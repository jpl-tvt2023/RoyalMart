-- Panchal joins the stage list, so the prefix master's CHECK has to widen.
--
-- Panchal is the warehouse. It is where finished goods actually sit as stock,
-- which is the job Packed was doing by accident -- migration 070 gave Packed an
-- In Stock status precisely because the chain had nowhere else to end. It has
-- somewhere now, and 082 moves that role across.
--
-- WHY A REBUILD. SQLite cannot ALTER a CHECK constraint, so widening an enum
-- means the full create-copy-drop-rename dance. Pattern set by 019, 028, 051,
-- 056, 064 and 066. Ids are carried across verbatim so audit_logs stays
-- attached, and the index is recreated because indexes do NOT survive a rebuild.
--
-- WHY THIRD PARTY IS NOT IN THIS LIST, even though 082 adds it to
-- stitching_entries. A prefix exists to print an incoming number on material
-- ARRIVING somewhere. Nothing arrives at Third Party -- the goods left the
-- building and the outbound bill is the handle. A Third Party prefix would be
-- one nobody could ever use, so the CHECK here covers the five receivable
-- stages only, and deriveIncomingNo skips the lookup entirely for that target.
--
-- THIS IS THE FIRST REBUILD IN THIS REPO OF A TABLE OTHER TABLES POINT AT, and
-- that needs a step the earlier ones did not. Every previous rebuild either had
-- no inbound references or ran before its children existed -- 066 rebuilt
-- outbound_po_line_receipts three migrations before stitching_entries started
-- referencing it. Here, outbound_po_line_receipts.incoming_prefix_id and
-- stitching_entries.incoming_prefix_id both point at this table and both hold
-- live values, so DROP TABLE performs an implicit DELETE FROM and every one of
-- those references becomes a violation.
--
-- PRAGMA defer_foreign_keys = ON does NOT rescue it, which is worth writing down
-- because it looks like it should. It defers the check to COMMIT, but SQLite
-- counts each violation as it happens and only decrements the counter when the
-- offending ROW is fixed. Renaming a new table into the old name does not touch
-- those rows, so the counter is still non-zero at COMMIT and the whole file
-- rolls back. PRAGMA foreign_keys = OFF is not available either: it is a no-op
-- inside a transaction, and migrate.js wraps every file in one.
--
-- So the references are detached and reattached around the rebuild. The ids are
-- unchanged by the copy, so what goes back is exactly what came off. Both
-- UPDATEs are scoped by the backup table, which means a row whose prefix was
-- already NULL is never touched.
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
  stage      TEXT NOT NULL CHECK (stage IN ('Gray','Processed','Stitched','Packed','Panchal')),
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO stitching_prefixes_new (id, prefix, stage, is_active, created_at, updated_by, updated_at)
  SELECT id, prefix, stage, is_active, created_at, updated_by, updated_at FROM stitching_prefixes;

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

-- One starter prefix for the new stage, on the same terms as the four migration
-- 067 seeded: renameable and deactivatable from Admin - Purchase Config, and
-- more can be added per stage. Without at least one active Panchal prefix,
-- sending anything to the warehouse fails with "No active Panchal prefix".
INSERT OR IGNORE INTO stitching_prefixes (prefix, stage) VALUES ('PNL', 'Panchal')
