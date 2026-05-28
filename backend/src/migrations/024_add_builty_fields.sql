-- Builty fields on marketplace_pos.
-- party_name is the consignee parsed out of the PO PDF's Ship-To section
-- bill_no is user-entered alphanumeric and must be globally unique when set
-- A partial unique index lets multiple NULL rows coexist
-- The migration runner splits on ASCII semicolons, so this file keeps them out of comments

ALTER TABLE marketplace_pos ADD COLUMN party_name TEXT;
ALTER TABLE marketplace_pos ADD COLUMN bill_no TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_marketplace_pos_bill_no
  ON marketplace_pos(bill_no) WHERE bill_no IS NOT NULL;
