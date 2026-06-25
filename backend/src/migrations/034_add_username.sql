-- Move login from email to a short username. Email is kept physically (vestigial,
-- auto-filled by the app) to avoid a destructive table rebuild on prod Turso. This
-- migration is purely additive plus a one-row dedupe, so it is FK-safe and runs
-- through the normal migrate runner (foreign_keys = ON).

-- 1. New login identifier, backfilled from the email local-part (lowercased).
ALTER TABLE users ADD COLUMN username TEXT;
UPDATE users SET username = lower(substr(email, 1, instr(email, '@') - 1));

-- 2. Remove stale case-variant duplicate accounts that collide on the derived username,
--    keeping the Admin/Owner row per username (fallback: lowest id). On this DB that
--    keeps id 12 (Keshav, Owner) and drops id 8 (Keshav, Employee/Office_POC). On fresh
--    or already-deduped DBs there are no collisions, so nothing is deleted. Safe under
--    foreign_keys = ON: the dropped row is referenced only by its own user_roles rows
--    (ON DELETE CASCADE) and nothing else.
DELETE FROM users WHERE id IN (
  SELECT u.id FROM users u
  WHERE EXISTS (SELECT 1 FROM users u2 WHERE u2.username = u.username AND u2.id <> u.id)
    AND u.id <> (
      SELECT keep.id FROM users keep WHERE keep.username = u.username
      ORDER BY (SELECT count(*) FROM user_roles r
                WHERE r.user_id = keep.id AND r.role IN ('Admin', 'Owner')) DESC,
               keep.id ASC
      LIMIT 1
    )
);

-- 3. Enforce uniqueness of the login identifier (the app also enforces presence/format).
CREATE UNIQUE INDEX idx_users_username ON users(username);
