-- An explicit close at the end of the stitching chain.
--
-- Reaching Packed used to BE the close: computeStatus returned 'Closed' for any
-- Packed lot the moment it was created, which made the Status column on that tab
-- a constant carrying no information and meant packed stock could never be
-- counted as outstanding. A Packed lot is now 'In Stock' -- finished goods
-- sitting in the warehouse -- until someone closes it, which is what records
-- that it was dispatched or consumed.
--
-- WHY BOTH TABLES. A lot arrives at Packed two different ways: forwarded through
-- the chain, which is a stitching_entries row, or bought directly at the Packed
-- stage, which is an outbound_po_line_receipts row whose incoming prefix maps to
-- Packed. The Stitching page reads those two as one list via a UNION ALL, so a
-- flag that lived on only one of them would leave half the Packed tab unable to
-- close. This is the same split challan_no already lives with, for the same
-- reason.
--
-- No backfill. Every Packed lot that exists today becomes 'In Stock', which is
-- the truthful answer -- nobody has closed one yet, because until now there was
-- nothing to close.
--
-- ADD COLUMN with a REFERENCES clause is legal because the implicit default is
-- NULL, the same pattern migrations 053, 058 and 068 used.
ALTER TABLE stitching_entries ADD COLUMN closed_at TEXT;

ALTER TABLE stitching_entries ADD COLUMN closed_by INTEGER REFERENCES users(id);

ALTER TABLE outbound_po_line_receipts ADD COLUMN closed_at TEXT;

ALTER TABLE outbound_po_line_receipts ADD COLUMN closed_by INTEGER REFERENCES users(id)
