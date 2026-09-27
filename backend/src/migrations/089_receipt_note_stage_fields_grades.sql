-- Three client asks in one additive migration: a receipt note, a party and rate
-- owned by each LOT, and a grade split on the lots that arrive graded.
--
-- 1. RECEIPT NOTE. outbound_po_line_receipts.note is free text, a paragraph the
--    person entering a delivery wants to leave for whoever reads the PO next.
--    Bounded at NOTE_MAX (1000) in the controller, not here, the same as every
--    other free-text cap in this schema.
--
-- 2. STAGE PARTY AND STAGE RATE, on BOTH lot tables. A lot is either a receipt
--    (goods booked in on a PO) or a stitching_entries row (goods that arrived on
--    a challan), and both kinds now say who has the goods at the stage they sit
--    at and what that stage costs -- PER METRE at Processing, PER DOZEN from
--    Stitching on, the unit the stage counts in (stageRateUnit).
--
--    WHY ON THE LOT AND NOT READ OFF A CHALLAN. The client confirmed that a
--    challan names its SENDER -- the party that held the goods at the stage they
--    LEFT, which is why the page reads "Stitching - MC" for goods MC sent out of
--    Stitching, and why a challan's rate is the rate of the stage being left. So
--    the challan that BROUGHT a lot in names the previous stage's party, and the
--    party working on the lot now is only known from the challans going OUT of
--    it. A lot nobody has sent on yet has no such challan, so the value has to
--    live on the lot itself.
--
--    ONE VALUE. The controller keeps a lot's stage_party_name and stage_rate
--    equal to party_name and process_rate on every live challan sent out of it
--    -- editing either side writes both (planStageSync). The columns below are
--    the lot's half of that pair.
--
--    BACKFILLED from the challans already sent out of each lot, but only where
--    they agree. A lot whose outgoing challans name two parties, or carry two
--    rates, is left blank rather than having one of them picked for it. The
--    first edit on such a lot makes its challans one value again. A rate is
--    only carried over when every outgoing challan has one, all the same, and
--    all in the LOT'S unit -- per metre out of a Processing lot, per dozen out
--    of a Stitching or Packing one. 087 stamped challans out of Processing per
--    dozen, and those are a different number from the per-metre rate the
--    Processing lot now holds, so such a lot starts blank. The rows keep their
--    own rate_unit and still add up correctly in the rate total.
--
-- 3. GRADES. A challan into Packing, Panchal or Third Party now arrives as ONE
--    lot with its Fresh, Second and Third dozens held side by side, instead of
--    one lot per grade line. A PO receipt booked straight into Packing or
--    Panchal records the same split. Balance and status still run on the TOTAL
--    dozens (received_dozens), so these three are what ARRIVED per grade, never
--    a second balance.
--
--    NOT NULL DEFAULT 0 because the client asked for 0 as the default, and an
--    ungraded row reads 0 in each rather than blank. REAL for the reason 083
--    gave: half dozens are ordinary.
--
--    Backfilled on stitching_entries from each row's own challan_type -- until
--    now every line WAS one grade, so its dozens belong wholly to that grade.
--    Write-offs are skipped, they are not lots. Rows with no challan_type (from
--    before 080) stay 0 in all three. Receipts have no grade to read, so they
--    start at 0 and are filled in on their next edit.
--
-- Additive only: ADD COLUMN, no rebuild, no index changes.
--
-- No semicolons may appear in these comments -- migrate.js splits on them.

ALTER TABLE outbound_po_line_receipts ADD COLUMN note TEXT;
ALTER TABLE outbound_po_line_receipts ADD COLUMN stage_party_name TEXT;
ALTER TABLE outbound_po_line_receipts ADD COLUMN stage_rate REAL;
ALTER TABLE outbound_po_line_receipts ADD COLUMN fresh_dozens REAL NOT NULL DEFAULT 0;
ALTER TABLE outbound_po_line_receipts ADD COLUMN second_dozens REAL NOT NULL DEFAULT 0;
ALTER TABLE outbound_po_line_receipts ADD COLUMN third_dozens REAL NOT NULL DEFAULT 0;

ALTER TABLE stitching_entries ADD COLUMN stage_party_name TEXT;
ALTER TABLE stitching_entries ADD COLUMN stage_rate REAL;
ALTER TABLE stitching_entries ADD COLUMN fresh_dozens REAL NOT NULL DEFAULT 0;
ALTER TABLE stitching_entries ADD COLUMN second_dozens REAL NOT NULL DEFAULT 0;
ALTER TABLE stitching_entries ADD COLUMN third_dozens REAL NOT NULL DEFAULT 0;

-- Grades on the existing entries, from the one grade each line was.
UPDATE stitching_entries SET fresh_dozens = COALESCE(received_dozens, 0)
 WHERE write_off_reason IS NULL AND challan_type = 'Fresh';
UPDATE stitching_entries SET second_dozens = COALESCE(received_dozens, 0)
 WHERE write_off_reason IS NULL AND challan_type = 'Second';
UPDATE stitching_entries SET third_dozens = COALESCE(received_dozens, 0)
 WHERE write_off_reason IS NULL AND challan_type = 'Third';

-- Stage party on entry lots, from their outgoing challans when those agree.
UPDATE stitching_entries
   SET stage_party_name = (
         SELECT MIN(c.party_name) FROM stitching_entries c
          WHERE c.parent_entry_id = stitching_entries.id
            AND c.deleted_at IS NULL AND c.write_off_reason IS NULL)
 WHERE write_off_reason IS NULL
   AND (SELECT COUNT(DISTINCT c.party_name) FROM stitching_entries c
         WHERE c.parent_entry_id = stitching_entries.id
           AND c.deleted_at IS NULL AND c.write_off_reason IS NULL) = 1;

-- Stage rate on entry lots: every outgoing challan priced, the same, in the
-- lot's own unit (metre at Processing, dozen after).
UPDATE stitching_entries
   SET stage_rate = (
         SELECT MIN(c.process_rate) FROM stitching_entries c
          WHERE c.parent_entry_id = stitching_entries.id
            AND c.deleted_at IS NULL AND c.write_off_reason IS NULL)
 WHERE write_off_reason IS NULL
   AND (SELECT COUNT(*) FROM stitching_entries c
         WHERE c.parent_entry_id = stitching_entries.id
           AND c.deleted_at IS NULL AND c.write_off_reason IS NULL) > 0
   AND (SELECT COUNT(*) FROM stitching_entries c
         WHERE c.parent_entry_id = stitching_entries.id
           AND c.deleted_at IS NULL AND c.write_off_reason IS NULL
           AND (c.process_rate IS NULL OR COALESCE(c.rate_unit, '')
                <> CASE WHEN stitching_entries.stage = 'Processing' THEN 'metre' ELSE 'dozen' END)) = 0
   AND (SELECT COUNT(DISTINCT c.process_rate) FROM stitching_entries c
         WHERE c.parent_entry_id = stitching_entries.id
           AND c.deleted_at IS NULL AND c.write_off_reason IS NULL) = 1;

-- The same two, on receipt lots.
UPDATE outbound_po_line_receipts
   SET stage_party_name = (
         SELECT MIN(c.party_name) FROM stitching_entries c
          WHERE c.parent_receipt_id = outbound_po_line_receipts.id
            AND c.deleted_at IS NULL AND c.write_off_reason IS NULL)
 WHERE (SELECT COUNT(DISTINCT c.party_name) FROM stitching_entries c
         WHERE c.parent_receipt_id = outbound_po_line_receipts.id
           AND c.deleted_at IS NULL AND c.write_off_reason IS NULL) = 1;

UPDATE outbound_po_line_receipts
   SET stage_rate = (
         SELECT MIN(c.process_rate) FROM stitching_entries c
          WHERE c.parent_receipt_id = outbound_po_line_receipts.id
            AND c.deleted_at IS NULL AND c.write_off_reason IS NULL)
 WHERE (SELECT COUNT(*) FROM stitching_entries c
         WHERE c.parent_receipt_id = outbound_po_line_receipts.id
           AND c.deleted_at IS NULL AND c.write_off_reason IS NULL) > 0
   AND (SELECT COUNT(*) FROM stitching_entries c
         WHERE c.parent_receipt_id = outbound_po_line_receipts.id
           AND c.deleted_at IS NULL AND c.write_off_reason IS NULL
           AND (c.process_rate IS NULL OR COALESCE(c.rate_unit, '')
                <> CASE WHEN (SELECT sp.stage FROM stitching_prefixes sp
                               WHERE sp.id = outbound_po_line_receipts.incoming_prefix_id) = 'Processing'
                        THEN 'metre' ELSE 'dozen' END)) = 0
   AND (SELECT COUNT(DISTINCT c.process_rate) FROM stitching_entries c
         WHERE c.parent_receipt_id = outbound_po_line_receipts.id
           AND c.deleted_at IS NULL AND c.write_off_reason IS NULL) = 1
