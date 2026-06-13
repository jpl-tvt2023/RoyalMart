-- TOTP multi-factor auth, disabled by default for all existing users.
-- mfa_secret holds the base32 TOTP secret once enrollment begins.
-- mfa_enabled flips to 1 only after the user verifies a code.

ALTER TABLE users ADD COLUMN mfa_secret TEXT;
ALTER TABLE users ADD COLUMN mfa_enabled INTEGER NOT NULL DEFAULT 0;
