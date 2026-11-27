-- LABEL PAGE LAYOUT -- two stickers per printed page (go-live feedback, 2026-11-27).
--
-- The warehouse's TSC TA210 roll carries TWO stickers side by side. The
-- client's own BarTender template for that printer says exactly how:
--
--   Page        150 x 103 mm, landscape   (one printer page = one pair)
--   Layout      2 rows, 1 column
--   Margins     top 1.3, bottom 1.3, left 0, right 0
--   Template    150 x 48.2 mm             (one sticker)
--   Gap         4.0 mm between the rows
--   check       1.3 + 48.2 + 4 + 48.2 + 1.3 = 103
--
-- Until now the station drew ONE sticker per page, at the size set here (152 x
-- 51 on prod). Chrome laid that small page onto the 150 x 103 paper centred,
-- so every sticker landed half on one label and half on the other -- barcode
-- on one, text on the next. The space it left above and below also counted as
-- page margins, which let Chrome print its own date, URL and page number.
--
-- So the print sheet now lays out N stickers per page the way BarTender does,
-- and the page is exactly the paper (no margin left for Chrome's header and
-- footer). Three new settings, set by Admin/Owner in Purchase Config ->
-- Barcode Station -> Label page:
--
--   labels_per_page   stickers stacked on one page (BarTender's Rows), 1 to 4
--   label_gap_mm      the gap between them (BarTender's vertical Gap), 0 to 20
--   page_margin_mm    the blank strip above the first and below the last
--                     sticker (BarTender's top and bottom Margins), 0 to 20
--
-- The page height is derived, never stored -- 2 x margin + N x sticker height
-- + (N - 1) x gap -- and the Admin sets the printer's paper to it.
--
-- One decimal place is now allowed (48.2, 1.3). label_width_mm and
-- label_height_mm are INTEGER-affinity columns, and SQLite keeps a value like
-- 48.2 in them as REAL with the CHECK still passing, so allowing decimals
-- there needs no table rebuild. The new gap and margin columns are REAL.
--
-- The defaults (1 per page, no gap, no margin) print exactly as before, until
-- an Admin enters the roll.
--
-- Additive: old code never reads these, so this file goes ahead of the deploy.
--
-- No semicolons may appear in these comments -- migrate.js splits on them.

ALTER TABLE barcode_station_settings
  ADD COLUMN labels_per_page INTEGER NOT NULL DEFAULT 1 CHECK (labels_per_page BETWEEN 1 AND 4);

ALTER TABLE barcode_station_settings
  ADD COLUMN label_gap_mm REAL NOT NULL DEFAULT 0 CHECK (label_gap_mm BETWEEN 0 AND 20);

ALTER TABLE barcode_station_settings
  ADD COLUMN page_margin_mm REAL NOT NULL DEFAULT 0 CHECK (page_margin_mm BETWEEN 0 AND 20)
