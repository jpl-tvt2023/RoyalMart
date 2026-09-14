-- A challan is identified by its number AND the party it went to, everywhere.
--
-- Migration 073 made challan_no unique PER PARENT LOT, in two partial indexes
-- because the parent lives in one of two nullable columns. That answered the
-- 40 + 60 question -- a lot split into two dispatches carries the same incoming
-- number on both halves, so the challan number is the only thing telling them
-- apart -- but it answered it too narrowly. Nothing stopped the same number
-- being raised against two different lots, and in practice a challan book is
-- not per lot. The number is printed once on a physical document handed to one
-- party, so the pair (number, party) is what is actually unique, and it is
-- unique across the whole business rather than within one lot's children.
--
-- Widening it this way makes two previously-refused things legal and one
-- previously-legal thing refused:
--   * the same number to two DIFFERENT parties is now fine -- two party's
--     challan books number from 1 independently, and they always did
--   * the same number twice on ONE lot to two different parties is now fine,
--     for the same reason
--   * the same number twice to the SAME party is now refused wherever it
--     happens, not just within one lot -- which is the slip worth catching
--
-- Scoped to LIVE rows, carried over verbatim from 073 and for its reason:
-- withdrawing a challan frees its number for the corrected entry, and
-- re-entering the same number against the right lot is exactly the wrong-lot
-- correction the Stitching page exists to allow. Write-offs carry no challan at
-- all, so challan_no IS NOT NULL keeps them out of the index entirely.
--
-- ONE index now, not two. The parent columns are not part of the key any more,
-- so the split that 073 needed -- parent_receipt_id in one, parent_entry_id in
-- the other -- has nothing left to express.
--
-- FOR WHOEVER REBUILDS THIS TABLE NEXT: recreate THIS index, not 073's. An
-- index does not survive the create-copy-drop-rename dance, and migration 082
-- recreated 073's pair verbatim at the end of its rebuild. Copying that block
-- again would silently restore the per-lot rule and drop this one.

DROP INDEX IF EXISTS idx_stitching_challan_per_receipt;

DROP INDEX IF EXISTS idx_stitching_challan_per_entry;

CREATE UNIQUE INDEX IF NOT EXISTS idx_stitching_challan_party
  ON stitching_entries(challan_no, party_name)
  WHERE deleted_at IS NULL AND challan_no IS NOT NULL;
