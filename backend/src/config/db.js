const { createClient } = require('@libsql/client');

const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:./local.db',
  authToken: process.env.TURSO_AUTH_TOKEN || undefined,
});

// Turso is reached over HTTP from a serverless function, so a cold start can hit
// a transient `fetch failed` before the connection settles. Unretried, that
// surfaces to whoever triggered the cold start as "Internal server error" on
// whatever they were doing — logging in included.
//
// Reads only, deliberately: a transport error does not tell us whether the
// statement reached the database or only its response was lost, so replaying a
// write risks a duplicate row. Transactions and batches go through
// db.transaction()/db.batch(), which are left untouched below. Writes still fail
// loudly, which is the honest outcome.
const TRANSIENT = /fetch failed|socket hang up|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i;
const READ_ONLY = /^\s*(SELECT|PRAGMA)\b/i;
const RETRY_ATTEMPTS = 3;

const sqlOf = (stmt) => (typeof stmt === 'string' ? stmt : stmt?.sql || '');
const isTransient = (err) => TRANSIENT.test(`${err?.message || ''} ${err?.cause?.message || ''}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const executeOnce = db.execute.bind(db);

db.execute = async (stmt, ...rest) => {
  const attempts = READ_ONLY.test(sqlOf(stmt)) ? RETRY_ATTEMPTS : 1;
  for (let attempt = 1; ; attempt++) {
    try {
      return await executeOnce(stmt, ...rest);
    } catch (err) {
      if (attempt >= attempts || !isTransient(err)) throw err;
      console.warn(`Transient DB error (attempt ${attempt}/${attempts}), retrying: ${err.message}`);
      await sleep(150 * attempt);
    }
  }
};

// SQLite/libsql does NOT enforce foreign keys (or ON DELETE CASCADE) unless this
// pragma is enabled. It is load-bearing for the local `file:./local.db` fallback,
// where the connection is long-lived and foreign keys default to OFF.
//
// Against Turso it is a harmless no-op: a fresh client already reports
// foreign_keys=1, and each HTTP request gets its own stream, so a pragma fired
// once at startup would not carry over anyway. A failure here therefore means
// the database was briefly unreachable at boot — NOT that referential integrity
// is switched off.
db.execute('PRAGMA foreign_keys = ON').catch((err) => {
  console.error('Database unreachable during startup pragma:', err.message);
});

module.exports = db;
