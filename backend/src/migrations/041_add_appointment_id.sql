-- Appointment ID on marketplace_pos.
-- Now and Blinkit POs carry an alphanumeric appointment identifier entered on the
-- GRN page, right after the appointment date (Zepto uses ASN instead).
-- Additive and nullable so existing rows are unaffected.
-- The migration runner splits on ASCII semicolons, so this file keeps them out of comments

ALTER TABLE marketplace_pos ADD COLUMN appointment_id TEXT;
