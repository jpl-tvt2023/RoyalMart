-- metre was never metres.
--
-- The column holds a quantity in whatever unit the PO line is measured in, which
-- is how "5 m" came to be printed against 5 corrugated boxes. The displays were
-- fixed by carrying unit_metric down from the PO line, the name was not, and the
-- name is what makes every reader ask the question again.
--
-- It also makes the two tables agree. outbound_po_line_receipts.received_qty has
-- carried that name since migration 053, and the receipt branch of the lots CTE
-- was aliasing it to metre purely to paper over the difference.
--
-- A rename preserves the data, and this is as cheap as it will ever get:
-- production is still at 066, so these tables do not exist there yet.

ALTER TABLE stitching_entries RENAME COLUMN metre TO received_qty;
