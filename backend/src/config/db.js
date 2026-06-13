const { createClient } = require('@libsql/client');
require('dotenv').config();

const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:./local.db',
  authToken: process.env.TURSO_AUTH_TOKEN || undefined,
});

// SQLite/libsql does NOT enforce foreign keys (or ON DELETE CASCADE) unless this
// pragma is enabled. Fire it on the shared client at startup so referential
// integrity declared in the migrations is actually enforced.
db.execute('PRAGMA foreign_keys = ON').catch((err) => {
  console.error('Failed to enable foreign_keys pragma:', err.message);
});

module.exports = db;
