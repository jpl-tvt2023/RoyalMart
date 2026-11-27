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

// Optional --until=<filename prefix>: apply pending files up to and including
// the first one whose name starts with it, then stop. For a release whose
// files must straddle a deploy -- some before it, some after:
//   node src/migrations/migrate.js --until=105
// Without it, every pending file is applied, as always.
const untilArg = process.argv.find(a => a.startsWith('--until='));
const UNTIL = untilArg ? untilArg.slice('--until='.length).trim() : null;

async function migrate() {
  try {
    // Enforce FKs during migrations (no-op inside a transaction, so set it first).
    await db.execute('PRAGMA foreign_keys = ON');

    await db.execute(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    const { rows: applied } = await db.execute('SELECT filename FROM schema_migrations');
    const appliedSet = new Set(applied.map(r => String(r.filename)));

    const dir = path.join(__dirname);
    let files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    if (UNTIL !== null) {
      const stop = UNTIL ? files.findIndex(f => f.startsWith(UNTIL)) : -1;
      if (stop === -1) throw new Error(`--until=${UNTIL} matches no migration file`);
      console.log(`  --until: stopping after ${files[stop]}`);
      files = files.slice(0, stop + 1);
    }

    for (const file of files) {
      if (appliedSet.has(file)) {
        console.log(`  skip: ${file}`);
        continue;
      }
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      const statements = splitSQL(sql);

      const tx = await db.transaction('write');
      try {
        for (const stmt of statements) {
          await tx.execute(stmt);
        }
        await tx.execute({ sql: 'INSERT INTO schema_migrations (filename) VALUES (?)', args: [file] });
        await tx.commit();
      } catch (err) {
        await tx.rollback();
        throw err;
      }
      console.log(`  applied: ${file}`);
    }
    console.log('Migrations complete.');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    db.close();
  }
}

migrate();
