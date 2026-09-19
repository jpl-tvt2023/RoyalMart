-- What to do about a delivery that does not match what was outstanding.
--
-- The receipt form shows the difference between what was received and what was
-- still due on the line, and offers exactly one of two boxes -- write off when
-- less turned up, rollover when more did. Ticking either demands a reason, which
-- is the whole point of recording it at all.
--
-- WRITE-OFF FILLS IN THE LINE'S EXISTING short. That column already means
-- "quantity that is never coming" and already closes a line through
-- computeLineStatus, so a second place recording the same idea would let a line
-- look open when everyone knows it is finished. The reason lives here on the
-- receipt, because short is a running total on the line and cannot hold one.
--
-- ROLLOVER CHANGES NO QUANTITY. Over-delivery is already accepted -- a receipt is
-- only refused once the line is Closed -- so the tick and its reason are the
-- record that the excess was deliberate rather than a typo.
--
-- Two columns rather than a boolean plus a reason: the action says which box was
-- ticked and the reason says why, and neither can be inferred from the other.

ALTER TABLE outbound_po_line_receipts ADD COLUMN qty_diff_action TEXT;

ALTER TABLE outbound_po_line_receipts ADD COLUMN qty_diff_reason TEXT;
