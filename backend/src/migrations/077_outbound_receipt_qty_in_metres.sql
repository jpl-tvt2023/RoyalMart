-- Fabric arrives in taga and is worked in metres.
--
-- A taga is a bundle, and how many metres are in one varies by roll, so there is
-- no factor to multiply by -- the user counts and enters the number. received_qty
-- stays in the line's own unit, which is what the PO, its balance and its Short
-- are all accounted in, and this column sits beside it holding the same delivery
-- expressed in metres.
--
-- THIS IS WHAT THE STITCHING PAGE COUNTS. A Gray lot's quantity is this column,
-- not received_qty, because every stage from Gray to Processed is measured in
-- metres. Populated only for articles flagged goes_to_stitching -- nothing else
-- reaches that page.
--
-- Nullable with no backfill on purpose. Existing receipts predate the field and
-- there is no honest value to invent for them, so a fabric receipt without one
-- reads as missing rather than as zero metres.

ALTER TABLE outbound_po_line_receipts ADD COLUMN qty_in_metres REAL;
