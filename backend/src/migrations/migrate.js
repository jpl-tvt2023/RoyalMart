require('../config/env');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@libsql/client');
require('dotenv').config();

const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:./local.db',
  authToken: process.env.TURSO_AUTH_TOKEN || undefined,
});

function splitSQL(sql) {
  return sql.split(';').map(s => s.trim()).filter(Boolean);
}

async function migrate() {
  try {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    const { rows: applied } = await db.execute('SELECT filename FROM schema_migrations');
    const appliedSet = new Set(applied.map(r => r.filename));

    const dir = path.join(__dirname);
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      if (appliedSet.has(file)) {
        console.log(`  skip: ${file}`);
        continue;
      }
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      const statements = splitSQL(sql);

      await db.batch(
        [
          ...statements.map(s => ({ sql: s })),
          { sql: 'INSERT INTO schema_migrations (filename) VALUES (?)', args: [file] },
        ],
        'write'
      );
      console.log(`  applied: ${file}`);
    }
    console.log('Migrations complete.');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  }
}

migrate();
