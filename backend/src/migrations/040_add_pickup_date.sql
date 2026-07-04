-- Pickup date on marketplace_pos.
-- Amazon and Flipkart POs have no expiry date. Instead a pickup date is agreed
-- up front and entered (mandatorily, enforced in the API) at onboarding.
-- Additive and nullable so existing rows are unaffected.
-- The migration runner splits on ASCII semicolons, so this file keeps them out of comments

ALTER TABLE marketplace_pos ADD COLUMN pickup_date TEXT;
