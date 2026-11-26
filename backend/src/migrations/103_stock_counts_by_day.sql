-- STOCK COUNTS BY DAY -- the client's change to 102, 2026-11-26.
--
-- Under 102 the scanner pressed Start before scanning and Close at the end,
-- and Close was what turned "not found" into Out. The client wants no such
-- step: scanning happens whenever, and goods that arrive in the evening belong
-- in that day's count. So the COUNT IS THE IST CALENDAR DAY:
--
--   The day's first scan creates that day's count (one row per count_date).
--   Every scan that day, evening deliveries included, goes into it.
--   At midnight IST the day is FINISHED, and a pack not scanned on it is Out
--     from then on. Nothing is stored for that -- a count is finished when its
--     count_date is before today, worked out at read time.
--   EVERY day with a scan is a full count (the client's choice). A short day
--     marks the unscanned packs Out, and the next full day brings them back
--     as missed scans. A day with no scans is no count and changes nothing.
--   Packs scanned today are In Stock at once. Out figures move only when a
--     day finishes.
--
-- Everything else in 102 stands -- Out at once, Not yet counted never Out,
-- missed scans Admin/Owner only, the floor flag, the cross-check.
--
-- THIS CLEARS THE COUNTS MADE SO FAR (the client's choice -- they were trial
-- counts made under Start and Close, several on one day, and Day 1 has not
-- happened). Both tables are dropped and made again, so closed_at, closed_by
-- and the one-open-count index go with them and no dead column is left. The
-- old counts' audit rows go too: the ids restart at 1 and would otherwise
-- attach to the new counts. Stickers, entries and keys are untouched.
--
-- ORDER: the 102 code reads closed_at and this code reads count_date, so apply
-- this right AFTER the deploy that carries the new code. In between only the
-- stock count fails, and nobody relies on it yet. Back up both tables first.
--
-- 1. stock_counts -- one row per IST day that has a scan. count_date is that
--    day (YYYY-MM-DD) and UNIQUE, so two PCs scanning at once share one row.
--    started_by is the operator of the day's first scan, plain text like every
--    station write.
--
-- 2. stock_count_scans -- unchanged from 102. One row per sticker per day, the
--    floor the scanner said he was on, PRIMARY KEY (count_id, label_key), so a
--    scan sent twice is a no-op and the station can resend its offline queue
--    blindly.
--
-- WARNING for future migrations (carried from 102): label_keys has a table
-- pointing at it. A rebuild of label_batches in the 101 style, which empties
-- label_keys and puts it back, must set stock_count_scans aside first and
-- restore it after (the 081 detach and reattach).
--
-- No semicolons may appear in these comments -- migrate.js splits on them.

DROP TABLE IF EXISTS stock_count_scans;

DROP TABLE IF EXISTS stock_counts;

CREATE TABLE stock_counts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  count_date TEXT NOT NULL UNIQUE CHECK (count_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  started_by TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE stock_count_scans (
  count_id   INTEGER NOT NULL REFERENCES stock_counts(id),
  label_key  INTEGER NOT NULL REFERENCES label_keys(label_key),
  floor_id   INTEGER NOT NULL REFERENCES floors(id),
  scanned_by TEXT NOT NULL,
  scanned_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (count_id, label_key)
);

CREATE INDEX idx_stock_count_scans_key ON stock_count_scans (label_key, count_id);

DELETE FROM audit_logs WHERE entity_type = 'stock_count'
