const db = require('../config/db');

// System users: rows in `users` that machines act as, so their writes are
// audited under a name of their own. Nobody signs in as one -- login refuses
// them before comparing a password, and the user admin refuses to delete them
// or reset their password.
//   tally-sync      (094) -- the RAMS integration, /api/integration
//   barcode-station (098) -- the public Barcode Station page, /api/station
const TALLY_SYNC_USERNAME = 'tally-sync';
const BARCODE_STATION_USERNAME = 'barcode-station';
const SYSTEM_USERNAMES = [TALLY_SYNC_USERNAME, BARCODE_STATION_USERNAME];

const isSystemUser = (user) => Boolean(user && SYSTEM_USERNAMES.includes(user.username));

// A system user as `req.user` carries it, looked up once per process. Null
// when the migration that creates it has not been applied (not cached, so
// applying it takes effect without a restart).
const cache = new Map();
async function systemUserByName(username) {
  if (cache.has(username)) return cache.get(username);
  const { rows } = await db.execute({
    sql: `SELECT u.id, u.username, u.name, GROUP_CONCAT(r.role) AS roles
            FROM users u LEFT JOIN user_roles r ON r.user_id = u.id
           WHERE u.username = ?
           GROUP BY u.id`,
    args: [username],
  });
  if (!rows.length) return null;
  const u = rows[0];
  const user = { id: Number(u.id), username: u.username, name: u.name, roles: u.roles ? String(u.roles).split(',') : [] };
  cache.set(username, user);
  return user;
}

const tallySyncUser = () => systemUserByName(TALLY_SYNC_USERNAME);
const barcodeStationUser = () => systemUserByName(BARCODE_STATION_USERNAME);

module.exports = {
  TALLY_SYNC_USERNAME, BARCODE_STATION_USERNAME, SYSTEM_USERNAMES,
  isSystemUser, systemUserByName, tallySyncUser, barcodeStationUser,
};
