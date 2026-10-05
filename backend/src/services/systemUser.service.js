const db = require('../config/db');

// System users: rows in `users` that machines act as, so their writes are
// audited under a name of their own. Nobody signs in as one (migration 094).
const TALLY_SYNC_USERNAME = 'tally-sync';
const SYSTEM_USERNAMES = [TALLY_SYNC_USERNAME];

const isSystemUser = (user) => Boolean(user && SYSTEM_USERNAMES.includes(user.username));

// The tally-sync user as `req.user` carries it, looked up once per process.
// Null when migration 094 has not been applied.
let tallySync = null;
async function tallySyncUser() {
  if (tallySync) return tallySync;
  const { rows } = await db.execute({
    sql: `SELECT u.id, u.username, u.name, GROUP_CONCAT(r.role) AS roles
            FROM users u LEFT JOIN user_roles r ON r.user_id = u.id
           WHERE u.username = ?
           GROUP BY u.id`,
    args: [TALLY_SYNC_USERNAME],
  });
  if (!rows.length) return null;
  const u = rows[0];
  tallySync = { id: Number(u.id), username: u.username, name: u.name, roles: u.roles ? String(u.roles).split(',') : [] };
  return tallySync;
}

module.exports = { TALLY_SYNC_USERNAME, SYSTEM_USERNAMES, isSystemUser, tallySyncUser };
