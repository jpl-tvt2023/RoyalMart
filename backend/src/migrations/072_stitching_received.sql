-- SUPERSEDED, and left in place deliberately. The two-step split described below
-- was reversed a day later: adding a challan IS sending the lot on, so there is
-- no window in which a row is dispatched but not received, and the In Transit
-- status and the receive endpoint are both gone.
--
-- The columns stay. Dropping one is destructive for no gain, and received_at is
-- still written -- dispatch and receipt are simply the same moment now, so the
-- value is honest. Nothing reads it to decide a status any more. Migration 075
-- renames metre to received_qty, so read the two together.
--
-- Everything below is the original note, kept because it explains why the
-- columns exist and why the backfill looks the way it does.
--
-- Dispatch and receipt become two steps instead of one.
--
-- Until now a lot moved to the next stage in a single action: the form captured
-- what went out AND what came back in the same submit. That cannot represent the
-- ordinary case of material sitting at a processor -- 40 of a 100 lot sent for
-- processing, with nothing back yet.
--
-- A stitching_entries row is now created at DISPATCH time, carrying the challan
-- number, the party it went to and how much left. metre is 0 and received_at is
-- NULL until the goods return, at which point the same row is filled in. So one
-- row is both the challan and the lot it becomes -- which is only sound because
-- a challan returns in one delivery, confirmed with the user. If part returns
-- are ever needed, this has to become its own table.
--
-- A row with received_at IS NULL reads as 'In Transit'. Without that status its
-- balance of 0 minus 0 would make computeStatus call it 'Forwarded' -- the one
-- value meaning "done with" -- so the branch in stitching.service.js is load
-- bearing, not cosmetic.
ALTER TABLE stitching_entries ADD COLUMN received_at TEXT;

ALTER TABLE stitching_entries ADD COLUMN received_by INTEGER REFERENCES users(id);

-- Every row that already exists was created by the old one-shot form, so it is
-- by definition already received. Stamping it from created_at keeps existing
-- data reading exactly as it does today rather than appearing to be in transit.
UPDATE stitching_entries SET received_at = created_at, received_by = created_by;

-- Challan No moves back onto the dispatch row. Migration 068 put it on the
-- receipt and a later change moved it to the PARENT lot, on the reasoning that a
-- challan belongs to "the lot being sent". With an explicit dispatch record that
-- is no longer true: a lot has many challans, and each one describes a single
-- dispatch. So push each parent's challan down onto the children that have none.
--
-- Where a lot had several dispatches they all inherit the one recorded challan.
-- That is imperfect and deliberately so -- it is the only information that
-- exists, and prod has no stitching rows at all, so this only touches test data.
UPDATE stitching_entries
SET challan_no = COALESCE(
      (SELECT pr.challan_no FROM outbound_po_line_receipts pr
        WHERE pr.id = stitching_entries.parent_receipt_id),
      (SELECT pe.challan_no FROM stitching_entries pe
        WHERE pe.id = stitching_entries.parent_entry_id)
    )
WHERE challan_no IS NULL
