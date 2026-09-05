-- Four additive columns on the receipts sub-ledger.
--
--   process_rate       -- cost of processing the raw material up to the stage it
--                         was received at. Optional, and 0 is meaningful (a Gray
--                         lot has had nothing done to it yet).
--
--   after_rate         -- the landed rate at this stage. The UI pre-fills it as
--                         received_rate + process_rate but the user may overwrite
--                         it, so it is stored rather than derived. The server
--                         fills the same default when the client omits it, so the
--                         two never disagree.
--
--   challan_no         -- delivery challan accompanying the goods. Lives here
--                         rather than on stitching_entries because a purchased
--                         lot's challan comes from the vendor's delivery, which
--                         makes the receipt the single source of truth for the
--                         origin row on the Stitching page.
--
--   incoming_prefix_id -- which stitching_prefixes row the incoming number was
--                         issued under, and therefore which stage this lot
--                         entered the process at.
--
-- All nullable with no backfill. The receipts that predate this change keep
-- working exactly as they do now -- they simply have no prefix, so they do not
-- appear on the Stitching page until someone assigns one. The
-- missing_incoming_stage flag surfaces them on the PO page so the gap stays
-- visible and fixable, the same way missing_incoming_no already does.
--
-- ADD COLUMN with a REFERENCES clause is legal because the implicit default is
-- NULL -- the same pattern migrations 053 and 058 used. stitching_prefixes is
-- created by 067, which runs first.
ALTER TABLE outbound_po_line_receipts ADD COLUMN process_rate REAL;

ALTER TABLE outbound_po_line_receipts ADD COLUMN after_rate REAL;

ALTER TABLE outbound_po_line_receipts ADD COLUMN challan_no TEXT;

ALTER TABLE outbound_po_line_receipts ADD COLUMN incoming_prefix_id INTEGER REFERENCES stitching_prefixes(id)
