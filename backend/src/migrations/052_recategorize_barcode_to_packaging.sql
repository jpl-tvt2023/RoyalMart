-- Barcode was seeded as 'Others' from historical outbound_vendor_articles
-- data, but should be categorized as 'Packaging'. Idempotent: also covers
-- packaging_raw_materials in case this runs on an environment where it
-- wasn't already corrected via the UI.

UPDATE packaging_raw_materials
SET category = 'Packaging', updated_at = datetime('now')
WHERE category = 'Others' AND item_name = 'Barcode';

UPDATE outbound_vendor_articles
SET category = 'Packaging'
WHERE category = 'Others' AND item_name = 'Barcode';
