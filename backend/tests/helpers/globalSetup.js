const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env.test') });

module.exports = async () => {
  const tmpDir = path.resolve(__dirname, '../.tmp');
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  const { createClient } = require('@libsql/client');
  const db = createClient({ url: process.env.TURSO_DATABASE_URL });

  await db.execute(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const migrationsDir = path.resolve(__dirname, '../../src/migrations');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    const statements = sql.split(';').map(s => s.trim()).filter(Boolean);
    for (const stmt of statements) {
      await db.execute(stmt);
    }
    await db.execute({
      sql: 'INSERT INTO schema_migrations (filename) VALUES (?)',
      args: [file],
    });
  }

  const seed01 = require('../../src/seeds/01_users.seed');
  await seed01(db);

  db.close();
};
