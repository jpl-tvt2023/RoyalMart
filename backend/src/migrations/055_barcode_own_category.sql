-- Barcode becomes a top-level category of its own. Migration 052 moved
-- ('Others','Barcode') into 'Packaging', but the target taxonomy is now
-- Raw Material / Packaging / Barcode / Others, with Barcode as a peer rather
-- than a Packaging sub-item. Targets by item_name so it catches the row
-- whatever category it currently sits in.
--
-- packaging_raw_materials still carries the 2-column UNIQUE (category,
-- item_name) at this point (migration 056 replaces it), so UPDATE OR IGNORE
-- skips any row that would collide with an already-correct ('Barcode',
-- 'Barcode') row, and the follow-up DELETE drops that now-redundant duplicate.
--
-- outbound_po_lines is included so historical POs stay consistent with the new
-- taxonomy and don't render as "removed from vendor config" on the detail
-- page. This is a taxonomy rename, not a data change -- the article's identity
-- (item_name plus variant) is untouched.

UPDATE OR IGNORE packaging_raw_materials
SET category = 'Barcode', updated_at = datetime('now')
WHERE LOWER(item_name) = 'barcode' AND category <> 'Barcode';

DELETE FROM packaging_raw_materials
WHERE LOWER(item_name) = 'barcode' AND category <> 'Barcode';

UPDATE outbound_vendor_articles
SET category = 'Barcode'
WHERE LOWER(item_name) = 'barcode' AND category <> 'Barcode';

UPDATE outbound_po_lines
SET category = 'Barcode', updated_at = datetime('now')
WHERE LOWER(item_name) = 'barcode' AND category <> 'Barcode'
