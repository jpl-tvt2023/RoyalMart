-- Drop the columns nothing reads any more.
--
-- Until now the rule was to leave a dead column in place. The client asked for
-- them to go, so a reader of the schema (or of the receipt form, which still
-- offered an After Rate nobody used) is not misled into thinking they matter.
-- Each one below was checked on test and prod before it was dropped.
--
--   outbound_products.stitching_type -- 091's None / Fabric / Readymade. The
--     UM now decides how an article travels and goes_to_stitching decides
--     whether it does, so the type was only written in step with the tick as a
--     rollback shim. Every typed row was ticked.
--
--   outbound_po_line_receipts.after_rate and stitching_entries.after_rate --
--     the running "received + process" rate. The rate total replaced it in 087
--     and nothing has read it since. Not one stored receipt value differed from
--     received_rate + process_rate, so nothing typed by hand is lost.
--
--   stitching_entries.received_at and received_by -- sending and receiving
--     became one moment, so both always equal created_at and created_by (true
--     of every row on test and prod). Nothing read them.
--
--   stitching_entries.party_id -- added by 082 for a party FK that was never
--     wired up. Never written, NULL on every row. party_name is the party.
--
--   outbound_po_lines.received -- the flat received count from before 053.
--     053 copied every value into a receipt row and the line's received has
--     been a SUM over its receipts ever since. Nothing writes the column, and
--     every read is shadowed by the computed alias of the same name.
--
-- A plain DROP COLUMN, as 031 and 063 did, because none of these is indexed,
-- UNIQUE, or named in a table-level CHECK. No table is rebuilt, so no foreign
-- key cascades and ids do not move. A column's own CHECK (stitching_type) and
-- a column's own REFERENCES (party_id, received_by) go with the column.
--
-- ORDER MATTERS ON DEPLOY. Code from before this migration still writes
-- stitching_type, after_rate and received_at / received_by, so deploy the code
-- that stops writing them FIRST and run this second. Rolling the code back past
-- this point needs the columns added back as nullable columns.

ALTER TABLE outbound_products DROP COLUMN stitching_type;
ALTER TABLE outbound_po_line_receipts DROP COLUMN after_rate;
ALTER TABLE stitching_entries DROP COLUMN after_rate;
ALTER TABLE stitching_entries DROP COLUMN received_at;
ALTER TABLE stitching_entries DROP COLUMN received_by;
ALTER TABLE stitching_entries DROP COLUMN party_id;
ALTER TABLE outbound_po_lines DROP COLUMN received;
