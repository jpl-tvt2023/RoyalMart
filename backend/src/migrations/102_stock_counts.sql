-- STOCK COUNTS -- Barcode Station phase 2. One person scans every stickered
-- pack in the warehouse every day. Nothing records goods leaving (dispatches
-- are never scanned), so movement is read off the counts themselves:
--
--   Day 1's closed count is the baseline.
--   A pack seen on an earlier count and missing from a closed count is OUT
--     (sold, dispatched, used) at once -- no waiting, no reason to enter.
--   An Out pack that is scanned again later goes back into stock, and the
--     counts it was missing from become MISSED SCANS (Admin/Owner only).
--   A sticker never scanned on any closed count is NOT YET COUNTED, never Out,
--     so stock that has not reached the shelf yet is not marked Out.
--   A pack scanned on a different floor from the one printed on its sticker is
--     FLAGGED (the scanner is told at once, the report shows it too).
--
-- None of that is stored. Only two things are written -- a count and its
-- scans -- and every status is worked out at read time from them, in SQL
-- (src/services/stockCount.service.js), the house rule for derivable data.
--
-- 1. stock_counts -- one row per count. started_by / closed_by are the typed
--    operator name, plain text like every station write, since nobody signs in
--    at the station. closed_at is NULL while the count is open. AT MOST ONE
--    COUNT IS OPEN at a time: a unique partial index over the constant
--    expression (closed_at IS NULL), so a second open row collides. Counts
--    therefore close in id order, which is the order the status rules read
--    them in. Only Admin/Owner can reopen a count, and only the latest one.
--
-- 2. stock_count_scans -- one row per sticker per count. floor_id is the floor
--    the scanner said he was on, not the sticker's floor. The PRIMARY KEY is
--    (count_id, label_key), so a scan sent twice -- a double-fire of the gun, a
--    retry after the Wi-Fi dropped -- is a no-op, which is what lets the
--    station queue scans offline and resend them blindly. The second index
--    serves the per-key reads (first and last sighting, gaps).
--
-- WARNING for future migrations: label_keys now has a table pointing at it.
-- 101 rebuilt label_batches by emptying label_keys and putting it back. A
-- rebuild like that must now set stock_count_scans aside first and restore it
-- after (the 081 detach and reattach), or the DELETE FROM label_keys fails on
-- the foreign key.
--
-- Additive only -- old code never reads any of it, so this file can be applied
-- ahead of the deploy.
--
-- No semicolons may appear in these comments -- migrate.js splits on them.

CREATE TABLE IF NOT EXISTS stock_counts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  started_by TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_by  TEXT,
  closed_at  TEXT,
  CHECK ((closed_at IS NULL) = (closed_by IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_counts_one_open ON stock_counts ((closed_at IS NULL)) WHERE closed_at IS NULL;

CREATE TABLE IF NOT EXISTS stock_count_scans (
  count_id   INTEGER NOT NULL REFERENCES stock_counts(id),
  label_key  INTEGER NOT NULL REFERENCES label_keys(label_key),
  floor_id   INTEGER NOT NULL REFERENCES floors(id),
  scanned_by TEXT NOT NULL,
  scanned_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (count_id, label_key)
);

CREATE INDEX IF NOT EXISTS idx_stock_count_scans_key ON stock_count_scans (label_key, count_id)
