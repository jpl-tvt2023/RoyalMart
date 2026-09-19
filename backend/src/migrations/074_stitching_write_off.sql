-- Material that leaves a lot without arriving anywhere.
--
-- Fabric ruined at rest -- 60 of a 100 lot that will never be sent on -- and a
-- whole challan that never comes back are the same event, and both are recorded
-- as a row nested under the lot beside its challans.
--
-- ONE COLUMN, NO FLAG. A write-off is a row where this reason is present, the
-- same way migration 071 lets a withdrawal be told from a plain delete by
-- whether revert_reason is set. A separate boolean could disagree with the
-- reason, so there is deliberately only one thing to read.
--
-- The row reuses sent_qty for the quantity written off, which is what makes this
-- cheap: `forwarded` already sums live children's sent_qty, so the parent's
-- balance falls with no change to the arithmetic anywhere. received_qty is 0
-- because nothing arrived, stage is the parent's because the material never
-- moved, and challan_no / incoming_no stay NULL because there is no challan and
-- no lot to number.

ALTER TABLE stitching_entries ADD COLUMN write_off_reason TEXT;
