-- Which articles go through the Stitching page.
--
-- Only fabric does. Everything else bought on an outbound PO -- packaging,
-- barcodes, corrugated boxes -- is received and done with, and putting it on a
-- stage chain it never travels was what made a Gray lot of corrugated boxes look
-- reasonable for a while.
--
-- A FLAG ON THE MASTER, not two hardcoded item names. The user asked for it this
-- way so a third fabric later is a tick in Admin rather than a release, and so a
-- rename does not silently drop an article out of the workflow.
--
-- outbound_po_lines carries category, item_name and unit_metric denormalised with
-- no product id, so the flag is read back by joining on that triple -- the same
-- lookup migration 057 used to backfill unit_metric onto lines.

ALTER TABLE outbound_products ADD COLUMN goes_to_stitching INTEGER NOT NULL DEFAULT 0;

-- item_name is COLLATE NOCASE, so this matches however the rows were typed.
UPDATE outbound_products
   SET goes_to_stitching = 1
 WHERE item_name IN ('Handkerchief - Bundle Fabric', 'Handkerchief - Cloth Fabrics');

-- The two fabrics by name, created only if the name is absent entirely. A PO
-- cannot carry an article the master does not know, so these have to exist for
-- the flag to mean anything -- but matching on item_name alone rather than on
-- the whole key means an installation that already has them under some other
-- category keeps its row and just gets the flag set above.
--
-- Both catalogs, because they answer different questions: a VENDOR mapping is
-- validated against packaging_raw_materials, while a PO line's unit metric comes
-- from outbound_products. An article missing from either one cannot be bought.
INSERT INTO packaging_raw_materials (category, item_name, variant, unit_metric)
SELECT 'Raw Material', 'Handkerchief - Bundle Fabric', '', 'taga'
 WHERE NOT EXISTS (SELECT 1 FROM packaging_raw_materials WHERE item_name = 'Handkerchief - Bundle Fabric');

INSERT INTO packaging_raw_materials (category, item_name, variant, unit_metric)
SELECT 'Raw Material', 'Handkerchief - Cloth Fabrics', '', 'taga'
 WHERE NOT EXISTS (SELECT 1 FROM packaging_raw_materials WHERE item_name = 'Handkerchief - Cloth Fabrics');

INSERT INTO outbound_products (category, item_name, unit_metric, goes_to_stitching)
SELECT 'Raw Material', 'Handkerchief - Bundle Fabric', 'taga', 1
 WHERE NOT EXISTS (SELECT 1 FROM outbound_products WHERE item_name = 'Handkerchief - Bundle Fabric');

INSERT INTO outbound_products (category, item_name, unit_metric, goes_to_stitching)
SELECT 'Raw Material', 'Handkerchief - Cloth Fabrics', 'taga', 1
 WHERE NOT EXISTS (SELECT 1 FROM outbound_products WHERE item_name = 'Handkerchief - Cloth Fabrics');
