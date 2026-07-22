-- Delivery/facility code (e.g. "HNR4") parsed from the "Delivery Address: <code>"
-- line in Amazon Now PO PDFs. Additive and nullable so existing rows/vendors are
-- unaffected — only vendor "Now" populates it.

ALTER TABLE marketplace_pos ADD COLUMN delivery_code TEXT;
