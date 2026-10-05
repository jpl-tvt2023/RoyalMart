-- The tally-sync system user, for the RAMS integration.
--
-- RAMS (Retail Accounts Management System) reads Royal Mart's Tally books and
-- writes Tally's own numbers back into the manual ROMS fields they belong in:
-- the Builty Bill No and Date, and the RTV Credit Note Number and Date. It calls
-- /api/integration with a bearer INTEGRATION_TOKEN rather than a login, and
-- serviceAuth.js runs each of those requests as this user. So every write lands
-- in audit_logs, and in the history drawer, as "Tally Sync" -- never as a person.
--
-- Nobody signs in as it. password_hash is not a bcrypt hash, so no password can
-- ever match it, and auth.controller.js refuses this username before it even
-- compares, so an Admin password reset cannot turn it into a working login.
--
-- Employee is the role every ordinary write route already admits. It adds no
-- reach: the integration routes check the token, not roles.
--
-- The email uses the reserved .invalid top-level domain, so it can never be a
-- real mailbox. INSERT OR IGNORE keeps the file safe to replay.

INSERT OR IGNORE INTO users (name, email, username, password_hash, is_first_login)
VALUES ('Tally Sync', 'tally-sync@system.invalid', 'tally-sync', '!system-account-no-login', 0);

INSERT OR IGNORE INTO user_roles (user_id, role)
SELECT id, 'Employee' FROM users WHERE username = 'tally-sync'
