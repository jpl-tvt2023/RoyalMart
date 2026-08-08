-- Client no longer wants HSN code stored anywhere. Direct DROP COLUMN is the
-- established pattern on this table (031_restructure_products.sql already
-- dropped 4 columns this way), no rebuild needed.
ALTER TABLE products DROP COLUMN hsn_code;
