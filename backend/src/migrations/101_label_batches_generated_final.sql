-- A generated Barcode Station batch is FINAL again.
--
-- 099 let an operator delete a generated batch, with a reason. The client has
-- since decided against it: once a batch's keys are generated it is final --
-- never edited, never deleted. Only a DRAFT (no keys yet) can still be edited
-- or deleted. So 098's rule comes back into the schema
--   CHECK (generated_at IS NULL OR deleted_at IS NULL)
-- and delete_reason, which only a generated delete ever wrote, is dropped as
-- dead. deleted_by stays: a draft delete still records who did it.
--
-- SQLite cannot add a CHECK in place, so label_batches is rebuilt the 099 way,
-- the 081 DETACH AND REATTACH: copy label_keys aside, empty it, rebuild
-- label_batches (ids carried verbatim, so audit_logs stays attached), recreate
-- its three indexes, put label_keys back, and assert with a guard that every
-- key came back -- any loss fails the guard and rolls the whole file back.
--
-- If a generated batch was soft-deleted while the 099 code was live, copying it
-- violates the restored CHECK and this file rolls back untouched. That is the
-- intended failure: such a row needs a decision, not a silent fix.
--
-- ORDER: this file goes AFTER the deploy that stops reading delete_reason. The
-- 099 code selects it, so running this first would break the live station.
--
-- No semicolons may appear in these comments -- migrate.js splits on them.

CREATE TABLE _mig101_keys AS SELECT label_key, batch_id, label_no FROM label_keys;

DELETE FROM label_keys;

CREATE TABLE label_batches_new (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  outbound_vendor_id INTEGER NOT NULL REFERENCES outbound_vendors(id),
  article_id         INTEGER NOT NULL REFERENCES packaging_raw_materials(id),
  floor_id           INTEGER NOT NULL REFERENCES floors(id),
  pack_size          INTEGER NOT NULL CHECK (pack_size > 0),
  label_count        INTEGER NOT NULL CHECK (label_count > 0),
  entered_by         TEXT NOT NULL,
  generated_at       TEXT,
  generated_by       TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at         TEXT,
  deleted_by         TEXT,
  CHECK ((generated_at IS NULL) = (generated_by IS NULL)),
  CHECK (generated_at IS NULL OR deleted_at IS NULL)
);

INSERT INTO label_batches_new
  (id, outbound_vendor_id, article_id, floor_id, pack_size, label_count, entered_by,
   generated_at, generated_by, created_at, updated_at, deleted_at, deleted_by)
SELECT id, outbound_vendor_id, article_id, floor_id, pack_size, label_count, entered_by,
       generated_at, generated_by, created_at, updated_at, deleted_at, deleted_by
  FROM label_batches;

DROP TABLE label_batches;

ALTER TABLE label_batches_new RENAME TO label_batches;

CREATE INDEX IF NOT EXISTS idx_label_batches_vendor  ON label_batches(outbound_vendor_id);
CREATE INDEX IF NOT EXISTS idx_label_batches_article ON label_batches(article_id);
CREATE INDEX IF NOT EXISTS idx_label_batches_floor   ON label_batches(floor_id);

INSERT INTO label_keys (label_key, batch_id, label_no)
SELECT label_key, batch_id, label_no FROM _mig101_keys;

-- THE GUARD: every key that went aside came back.
CREATE TABLE _mig101_guard (keys_restored INTEGER CHECK (keys_restored = 1));

INSERT INTO _mig101_guard (keys_restored)
SELECT (SELECT COUNT(*) FROM label_keys) = (SELECT COUNT(*) FROM _mig101_keys);

DROP TABLE _mig101_guard;

DROP TABLE _mig101_keys
