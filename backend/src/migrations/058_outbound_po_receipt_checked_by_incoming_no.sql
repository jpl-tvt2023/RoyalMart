-- Two new fields on the receipts sub-ledger.
--
--   checked_by  -- the Warehouse_POC who physically verified the delivery.
--                  Mandatory on every NEW receipt, enforced in the controller
--                  rather than as NOT NULL because historical rows (including
--                  the ones migration 053 synthesized from the legacy flat
--                  `received` value) have no such user to backfill.
--
--   incoming_no -- warehouse incoming/gate register number, a whole number.
--                  Optional by design, but a receipt without one raises a flag
--                  on the PO so the gap stays visible and fixable.
--
-- ADD COLUMN with a REFERENCES clause is legal here because the implicit
-- default is NULL, the same pattern migration 053 used.
--
-- No new index is needed: the flag EXISTS subqueries walk
-- idx_outbound_po_lines_po then idx_outbound_po_line_receipts_line, both of
-- which already exist.
ALTER TABLE outbound_po_line_receipts ADD COLUMN checked_by INTEGER REFERENCES users(id);

ALTER TABLE outbound_po_line_receipts ADD COLUMN incoming_no INTEGER
