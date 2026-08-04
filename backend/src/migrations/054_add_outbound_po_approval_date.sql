-- Approval Date: becomes mandatory alongside Approved By whenever the
-- approver is set for the first time or changed to a different user
-- (enforced in the controller, not a CHECK constraint since it's
-- conditional). Nullable here since existing POs already carry an approver
-- with no historical approval date to backfill.
ALTER TABLE outbound_pos ADD COLUMN approval_date TEXT;
