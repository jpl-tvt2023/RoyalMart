-- A GENERATED Barcode Station batch can now be deleted, with a reason.
--
-- 098 made a generated batch permanent -- CHECK (generated_at IS NULL OR
-- deleted_at IS NULL) -- on the grounds that its stickers may already be on
-- boxes. The client wants operators to be able to delete one anyway (a wrong
-- entry, a trial run). The stickers' safety moves from the schema to the keys:
--
-- * label_keys rows are NEVER deleted, so a deleted batch's keys stay taken and
--   are never handed to another batch. A reprinted or scanned old sticker can
--   only ever resolve to the batch it was printed for -- and the API answers
--   that the batch was deleted, so the sticker reads as no longer valid.
-- * Deleting a generated batch needs a reason (barcodeStation.service.js
--   deleteReasonError, mirrored in the frontend). A draft still needs none.
--
-- New columns, kept on the row so a scan of a dead sticker can say who and why:
--   deleted_by    -- the operator's typed name, like entered_by / generated_by
--   delete_reason -- free text, up to 300 characters, required once generated
--
-- SQLite cannot drop a CHECK, so label_batches is rebuilt. label_keys points at
-- it, so this is the 081 DETACH AND REATTACH: copy label_keys aside, empty it,
-- rebuild label_batches (ids carried verbatim, so audit_logs stays attached),
-- recreate its three indexes, put label_keys back. A guard then asserts the key
-- count survived -- any loss fails its CHECK and rolls the whole file back.
-- label_batches is still the only table that references packaging_raw_materials.
--
-- Old code never reads the two new columns and never deletes a generated batch,
-- so this file can be applied ahead of the deploy.
--
-- No semicolons may appear in these comments -- migrate.js splits on them.

CREATE TABLE _mig099_keys AS SELECT label_key, batch_id, label_no FROM label_keys;

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
  delete_reason      TEXT,
  CHECK ((generated_at IS NULL) = (generated_by IS NULL))
);

INSERT INTO label_batches_new
  (id, outbound_vendor_id, article_id, floor_id, pack_size, label_count, entered_by,
   generated_at, generated_by, created_at, updated_at, deleted_at)
SELECT id, outbound_vendor_id, article_id, floor_id, pack_size, label_count, entered_by,
       generated_at, generated_by, created_at, updated_at, deleted_at
  FROM label_batches;

DROP TABLE label_batches;

ALTER TABLE label_batches_new RENAME TO label_batches;

CREATE INDEX IF NOT EXISTS idx_label_batches_vendor  ON label_batches(outbound_vendor_id);
CREATE INDEX IF NOT EXISTS idx_label_batches_article ON label_batches(article_id);
CREATE INDEX IF NOT EXISTS idx_label_batches_floor   ON label_batches(floor_id);

INSERT INTO label_keys (label_key, batch_id, label_no)
SELECT label_key, batch_id, label_no FROM _mig099_keys;

-- THE GUARD: every key that went aside came back.
CREATE TABLE _mig099_guard (keys_restored INTEGER CHECK (keys_restored = 1));

INSERT INTO _mig099_guard (keys_restored)
SELECT (SELECT COUNT(*) FROM label_keys) = (SELECT COUNT(*) FROM _mig099_keys);

DROP TABLE _mig099_guard;

DROP TABLE _mig099_keys
