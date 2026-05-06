-- Order Summary owns Office POC, Warehouse POC, and Dispatch Date directly
-- on marketplace_pos (one summary row per PO). Status / updated_by / updated_at
-- already exist on the table, so no further audit columns are needed.

ALTER TABLE marketplace_pos ADD COLUMN office_poc    INTEGER REFERENCES users(id);
ALTER TABLE marketplace_pos ADD COLUMN warehouse_poc INTEGER REFERENCES users(id);
ALTER TABLE marketplace_pos ADD COLUMN dispatch_date TEXT;
