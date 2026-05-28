-- GRN (Goods Receipt Note) fields on marketplace_pos
-- appointment_date is the scheduled drop-off slot at the marketplace warehouse
-- asn is a vendor-supplied advance shipment notice number (Zepto-only in the UI)
-- grn_status is the receipt lifecycle, NULL means computed from dispatch state
-- grn_date, grn_qty, grn_number capture the actual receipt
-- discrepancy_qty and discrepancy_number capture any shortage or damage at receipt
-- The migration runner splits on ASCII semicolons, so this file keeps them out of comments

ALTER TABLE marketplace_pos ADD COLUMN appointment_date   TEXT;
ALTER TABLE marketplace_pos ADD COLUMN asn                TEXT;
ALTER TABLE marketplace_pos ADD COLUMN grn_status         TEXT;
ALTER TABLE marketplace_pos ADD COLUMN grn_date           TEXT;
ALTER TABLE marketplace_pos ADD COLUMN grn_qty            INTEGER;
ALTER TABLE marketplace_pos ADD COLUMN grn_number         TEXT;
ALTER TABLE marketplace_pos ADD COLUMN discrepancy_qty    INTEGER;
ALTER TABLE marketplace_pos ADD COLUMN discrepancy_number TEXT;
