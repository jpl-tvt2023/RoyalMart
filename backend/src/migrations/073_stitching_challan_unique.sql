-- Challan numbers must be distinct within one lot.
--
-- A lot of 100 sent as 40 and 60 becomes two rows that are identical in almost
-- every way. Both carry the same incoming number by design -- the number
-- identifies the material that came off the origin lot, so every part of it
-- carries the same one at every stage -- which leaves the challan number as the
-- only thing telling the two dispatches apart. Two physical challans always have
-- two numbers, so entering one twice is a slip, not a case to support.
--
-- Two indexes because the parent lives in one of two nullable columns and the
-- table's own CHECK guarantees exactly one is set.
--
-- Scoped to LIVE rows, which is deliberate. Withdrawing a challan frees its
-- number for the corrected entry, and re-entering the same number against the
-- right lot is exactly the wrong-PO correction this page exists to allow.
--
-- Write-offs carry no challan at all, so the challan_no IS NOT NULL clause keeps
-- them out of the index entirely.

CREATE UNIQUE INDEX IF NOT EXISTS idx_stitching_challan_per_receipt
  ON stitching_entries(parent_receipt_id, challan_no)
  WHERE deleted_at IS NULL AND parent_receipt_id IS NOT NULL AND challan_no IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_stitching_challan_per_entry
  ON stitching_entries(parent_entry_id, challan_no)
  WHERE deleted_at IS NULL AND parent_entry_id IS NOT NULL AND challan_no IS NOT NULL;
