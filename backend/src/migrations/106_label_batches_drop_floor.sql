-- A LABEL ENTRY HAS NO FLOOR (client, 2026-11-27).
--
-- 098 gave every Barcode Station entry a floor, printed on its stickers as the
-- "Panchal Floor", and 102 flagged a pack scanned anywhere else as on the
-- wrong floor. On go-live day the client changed that: packs move between
-- floors as a matter of course, so the floor is not set when an entry is made
-- or its keys are generated, and is not printed. A pack gets its location
-- ONLY from the stock count -- it is on the floor of its latest day's scan
-- (stock_count_scans.floor_id), and has no location at all until its first
-- scan. Nothing reads label_batches.floor_id any more, so it goes.
--
-- A plain DROP COLUMN, not a table rebuild: libsql allows it once the index
-- on the column is gone (the column's own REFERENCES is fine -- 093 did the
-- same). label_keys and stock_count_scans are untouched.
--
-- ORDER: the old code reads b.floor_id (BATCH_SELECT joins floors on it), so
-- this goes AFTER the deploy of the code that stops reading and writing it.
-- Until then the new code's "Save entry" fails (the column is NOT NULL and the
-- new code no longer fills it) -- list, Generate, print and scans keep working.
-- Deploy at a quiet time and apply this straight after. Back up
-- label_batches (id, floor_id) first: this deletes the floors the entries made
-- before it carried.
--
-- No semicolons may appear in these comments -- migrate.js splits on them.

DROP INDEX IF EXISTS idx_label_batches_floor;

ALTER TABLE label_batches DROP COLUMN floor_id
