-- Fabric and Readymade, and goods bought straight into Third Party.
--
-- Two client asks from the first fortnight of live use, one additive migration.
--
-- 1. STITCHING TYPE on the Outbound Product List. Until now an article either
--    travelled the Stitching page or did not -- goes_to_stitching, a tick (076).
--    The client now buys READYMADE goods too (socks, caps, bandanas) that are
--    stitched, packed and stocked like fabric but are never processed: they
--    arrive already made up, counted in pieces or dozens, with no metres at all.
--    So the tick becomes a choice -- none, Fabric or Readymade -- and the type
--    decides which section of the Stitching page a lot shows in. Readymade has
--    no Processing stage, which is the whole difference between the two.
--
--    A NEW COLUMN rather than a reinterpreted one. goes_to_stitching is left in
--    place and kept in step by the controller (stitching_type IS NOT NULL), the
--    house rule for a superseded column, but nothing reads it any more.
--    Backfilled Fabric from the tick, which is exactly what every ticked row was.
--
--    The type is read back through the (category, item_name, unit_metric) triple
--    a PO line carries, like the tick was. Changing it is refused while the
--    article has lots on the Stitching page, because those lots would otherwise
--    jump sections, or (Fabric to Readymade at Processing) land on a tab that
--    does not exist. Enforced in outboundProducts.controller.js.
--
-- 2. THIRD PARTY AS A RECEIPT STAGE. A receipt used to land at Processing,
--    Stitching, Packing or Panchal only. The client buys goods that are sold on
--    without ever entering our stock, so a receipt may now land straight at
--    Third Party -- the exit. Exactly like a challan into Third Party it gets NO
--    incoming number (nothing arrives anywhere), carries OUR outbound bill
--    number, and names a Warehouse POC who checked it over.
--
--    direct_stage holds the stage for such a receipt. Every other receipt keeps
--    deriving its stage from incoming_prefix_id, and stitching_prefixes cannot
--    hold a Third Party row (its CHECK lists the receivable stages, and a prefix
--    is an incoming number, which Third Party has none of). The CHECK admits the
--    one value that has no prefix, so this column can never disagree with one.
--
--    outbound_bill_no sits beside the vendor's own bill_no. The two are
--    different documents -- theirs is what we were billed, ours is what the
--    buyer is billed -- and stitching_entries already calls ours by this name.
--
-- Additive only: ADD COLUMN, no rebuild, no index changes. An ADD COLUMN CHECK
-- is attached and enforced by libSQL, as 013 relied on.
--
-- No semicolons may appear in these comments -- migrate.js splits on them.

ALTER TABLE outbound_products ADD COLUMN stitching_type TEXT CHECK (stitching_type IN ('Fabric', 'Readymade'));

UPDATE outbound_products SET stitching_type = 'Fabric' WHERE goes_to_stitching = 1;

ALTER TABLE outbound_po_line_receipts ADD COLUMN direct_stage TEXT CHECK (direct_stage = 'Third Party');

ALTER TABLE outbound_po_line_receipts ADD COLUMN outbound_bill_no TEXT;
