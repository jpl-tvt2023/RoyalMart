-- Deleted POs must be "as good as freshly onboarded". Historically, soft-delete
-- only flipped status, so deleted rows kept workflow data — including bill_no,
-- which still counts against the global UNIQUE index and made re-using such a
-- bill no on an active PO fail with a raw SQLITE_CONSTRAINT 500 (e.g. "564" held
-- by deleted M009). The delete endpoint now clears these fields. This backfills
-- rows deleted before that change. Onboarding fields (dates, city, party_name,
-- appointment_date) and PO lines are kept.
UPDATE marketplace_pos
SET office_poc = NULL, warehouse_poc = NULL, dispatch_date = NULL, courier_id = NULL,
    tracking_id = NULL, bill_no = NULL, bill_date = NULL, asn = NULL, appointment_id = NULL,
    grn_status = NULL, grn_date = NULL, grn_qty = NULL, grn_number = NULL,
    discrepancy_qty = NULL, discrepancy_number = NULL, note = NULL
WHERE status = 'Deleted';
