-- The unit a receipt was counted in, recorded rather than assumed.
--
-- A receipt has always held received_qty in the LINE's unit metric by
-- convention alone. Nothing stored it, and the only trace of it was the hint
-- under the Received Qty box reading "In taga, as ordered" -- a label composed
-- at render time from outbound_po_lines.unit_metric.
--
-- That convention holds right up until the line's UM is not the whole story.
-- Fabric is the case in hand: bought in taga, worked in metres, and migration
-- 077 already added qty_in_metres beside received_qty for exactly that reason.
-- With two quantities on one row and only one of them carrying a named unit,
-- the row cannot say what it means on its own -- a report, an export or an
-- audit diff has to reach back to the line to find out, and a line whose UM was
-- later switched reinterprets every receipt already taken against it.
--
-- So the unit is copied onto the receipt at write time, on exactly the same
-- principle and for exactly the same reason that migration 064 copied it onto
-- the line: what a past delivery recorded must not change because a master was
-- edited afterwards.
--
-- NULLABLE, and deliberately so. The backfill below fills every row that has a
-- line UM to inherit, but a line whose own unit_metric is NULL has nothing to
-- give -- those rows predate the metric being captured at all, and inventing a
-- unit for them would be a worse record than admitting there isn't one. The
-- read path falls back to the line's UM, which is what it did before this
-- column existed.
--
-- The allowed values are NOT constrained here. They are whatever the Outbound
-- Product List publishes for the line's (category, item_name) pair, which is a
-- moving set held in outbound_products -- a CHECK would freeze today's answer
-- into the schema and need a full table rebuild every time an admin adds a
-- metric. resolveLineMetric in outboundPOs.controller.js is the enforcement,
-- and it grandfathers the catalog default and the stored value so that editing
-- a master can never leave an existing receipt unsaveable.

ALTER TABLE outbound_po_line_receipts ADD COLUMN unit_metric TEXT;

UPDATE outbound_po_line_receipts
   SET unit_metric = (
     SELECT l.unit_metric FROM outbound_po_lines l WHERE l.id = outbound_po_line_receipts.line_id
   )
 WHERE unit_metric IS NULL;
