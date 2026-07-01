-- Bill date on marketplace_pos.
-- Mandatory (enforced in the API) whenever a bill_no is set or modified.
-- Additive and nullable so existing rows are unaffected.
-- The migration runner splits on ASCII semicolons, so this file keeps them out of comments

ALTER TABLE marketplace_pos ADD COLUMN bill_date TEXT;
