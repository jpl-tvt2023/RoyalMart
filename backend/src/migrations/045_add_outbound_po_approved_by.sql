-- Optional "Approved By" reference on outbound POs, set on the same form
-- used for both creating and editing a PO.

ALTER TABLE outbound_pos ADD COLUMN approved_by INTEGER REFERENCES users(id);
