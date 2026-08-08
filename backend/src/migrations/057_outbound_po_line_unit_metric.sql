-- Unit Metric becomes a first-class PO-line attribute so the PO list and
-- detail screens can show UM between Qty and Rate.
--
-- Like every other line field this is a denormalized COPY taken from the
-- catalog when the line is written (see the header comment on migration 044),
-- so a later catalog edit can never retroactively rewrite what a past PO said.
ALTER TABLE outbound_po_lines ADD COLUMN unit_metric TEXT;

UPDATE outbound_po_lines
SET unit_metric = (SELECT p.unit_metric FROM packaging_raw_materials p
                   WHERE p.category = outbound_po_lines.category
                     AND p.item_name = outbound_po_lines.item_name
                     AND p.variant = COALESCE(outbound_po_lines.variant, ''))
WHERE unit_metric IS NULL;

-- Variant-insensitive fallback for historical lines whose free-text variant
-- never made it into the catalog. MIN picks a deterministic row when an item
-- has several variants with differing metrics.
UPDATE outbound_po_lines
SET unit_metric = (SELECT MIN(p.unit_metric) FROM packaging_raw_materials p
                   WHERE p.category = outbound_po_lines.category
                     AND p.item_name = outbound_po_lines.item_name)
WHERE unit_metric IS NULL
