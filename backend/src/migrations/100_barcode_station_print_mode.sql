-- How the Barcode Station prints: through the browser's print dialog, or
-- straight to the printer on a kiosk PC.
--
-- The client wants warehouse staff to print labels WITHOUT seeing them -- no
-- preview of the stickers, whose keys only Admins may see. The station never
-- draws the stickers on screen any more, but a browser still opens its own
-- print dialog, with its own preview, unless Chrome or Edge was started with
-- --kiosk-printing, which sends the job straight to the default printer.
--
-- The station PCs are not set up for kiosk printing yet, so both ways are kept
-- behind this switch, set by Admin/Owner in Purchase Config -> Barcode Station:
--   dialog -- the default. The station shows tips for the print dialog
--             (printer, paper size, scale 100 percent, margins none).
--   direct -- for kiosk PCs. The station sends the job and reports it sent.
-- The app cannot make a plain browser skip its dialog. direct is only truly
-- preview-free on a PC launched from the kiosk shortcut.
--
-- Additive: old code never reads it, so this file goes ahead of the deploy.
--
-- No semicolons may appear in these comments -- migrate.js splits on them.

ALTER TABLE barcode_station_settings
  ADD COLUMN print_mode TEXT NOT NULL DEFAULT 'dialog' CHECK (print_mode IN ('dialog', 'direct'))
