// Refresh the TEST database's data from PRODUCTION, in place.
//
//   npm run db:refresh-test            -- check: read-only on both, reports only
//   npm run db:refresh-test -- apply   -- backs up test, then replaces its data
//
// Reads the test DB from backend/.env and prod from backend/.env.prod (both
// gitignored). Refuses to run unless .env names royalmart-roms-test and
// .env.prod names royalmart-roms.
//
// PRODUCTION IS ONLY EVER READ: one read transaction, SELECT and PRAGMA only.
//
// Why in place, not `turso db destroy` + `turso db create --from-db`: the test
// DB's auth token carries the database id, so a recreated DB needs a new token
// in backend/.env AND in Vercel's Preview env vars, then a redeploy of the test
// environment. Copying rows keeps the URL and token, so nothing else changes,
// and it needs no Turso CLI login.
//
// What it does:
//   1. Refuses unless both schemas are IDENTICAL (same tables, indexes and
//      their SQL). So run it only when both DBs have the same migrations --
//      a migration applied to test ahead of prod blocks the refresh until prod
//      catches up.
//   2. Refuses if prod fails PRAGMA foreign_key_check.
//   3. Reads every table of prod in one read transaction (a consistent snapshot).
//   4. apply: writes a JSON backup of the test DB to backend/backups/ (gitignored),
//      then, in ONE write transaction on test, deletes every row and inserts
//      prod's rows, parents before children, and copies sqlite_sequence last.
//      Any error rolls the whole thing back and test is left untouched.
//   5. Verifies every table is byte-identical to the prod snapshot, plus
//      sqlite_sequence, integrity_check and foreign_key_check.
//
// Side effects worth knowing: test then has prod's users and passwords, and
// prod's Barcode Station PIN (test station devices may need to unlock again).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@libsql/client');

const BACKEND = path.join(__dirname, '..');

const envOf = (file) => Object.fromEntries(
  fs.readFileSync(path.join(BACKEND, file), 'utf8').split(/\r?\n/)
    .map((l) => l.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean)
    .map((m) => [m[1], m[2].trim().replace(/^"|"$/g, '')]),
);

const isUserTable = (n) => !/^(sqlite_|libsql_)/.test(n);
const q = (name) => `"${name.replace(/"/g, '""')}"`;
const plain = (rows) => rows.map((r) => ({ ...r }));
const digest = (t) => crypto.createHash('sha256').update(JSON.stringify(t.rows)).digest('hex').slice(0, 16);
const MAX_PARAMS = 500;

async function schemaOf(c) {
  const { rows } = await c.execute(
    'SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name');
  return rows.filter((r) => isUserTable(r.tbl_name)).map((r) => ({
    type: r.type, name: r.name, sql: String(r.sql).replace(/\s+/g, ' ').trim(),
  }));
}

// Every table of `c`, read inside one read transaction.
async function snapshot(c, tables) {
  const tx = await c.transaction('read');
  try {
    const data = {};
    const fks = {};
    for (const t of tables) {
      const cols = (await tx.execute(`PRAGMA table_info(${q(t)})`)).rows.map((r) => r.name);
      const { rows } = await tx.execute(`SELECT * FROM ${q(t)} ORDER BY rowid`);
      data[t] = { cols, rows: rows.map((r) => cols.map((col) => r[col])) };
      fks[t] = [...new Set((await tx.execute(`PRAGMA foreign_key_list(${q(t)})`)).rows.map((r) => r.table))];
    }
    const seq = plain((await tx.execute('SELECT name, seq FROM sqlite_sequence ORDER BY name')).rows);
    return { data, seq, fks };
  } finally {
    tx.close();
  }
}

// Parents before children. A self-reference is skipped (rows go in rowid order).
function topoOrder(tables, fks) {
  const done = new Set();
  const order = [];
  const visit = (t, trail = new Set()) => {
    if (done.has(t)) return;
    if (trail.has(t)) throw new Error(`foreign-key cycle through ${t}`);
    trail.add(t);
    for (const p of fks[t] || []) if (p !== t && tables.includes(p)) visit(p, trail);
    trail.delete(t);
    done.add(t);
    order.push(t);
  };
  tables.forEach((t) => visit(t));
  return order;
}

async function run(mode, prod, test, testUrl) {
  // 1. Schemas must match exactly.
  const [ps, ts] = await Promise.all([schemaOf(prod), schemaOf(test)]);
  const key = (o) => `${o.type}:${o.name}`;
  const pm = new Map(ps.map((o) => [key(o), o.sql]));
  const tm = new Map(ts.map((o) => [key(o), o.sql]));
  const diffs = [];
  for (const [k, s] of pm) if (tm.get(k) !== s) diffs.push(`${k}: ${tm.has(k) ? 'different' : 'missing on test'}`);
  for (const k of tm.keys()) if (!pm.has(k)) diffs.push(`${k}: on test only`);
  console.log(`schema objects: prod ${ps.length}, test ${ts.length}`);
  if (diffs.length) {
    console.error('SCHEMA MISMATCH -- refusing. Bring both DBs to the same migrations first:\n  ' + diffs.join('\n  '));
    return 1;
  }
  console.log('schemas identical');
  const tables = ps.filter((o) => o.type === 'table').map((o) => o.name);

  // 2. Prod must be clean.
  const fkProd = (await prod.execute('PRAGMA foreign_key_check')).rows;
  const icProd = (await prod.execute('PRAGMA integrity_check')).rows.map((r) => Object.values(r)[0]);
  console.log(`prod foreign_key_check: ${fkProd.length} violations | integrity_check: ${icProd.join(',')}`);
  if (fkProd.length) {
    console.error('prod has foreign-key violations -- refusing');
    console.table(plain(fkProd).slice(0, 20));
    return 1;
  }

  // 3. Prod snapshot.
  console.log('reading prod...');
  const P = await snapshot(prod, tables);
  const order = topoOrder(tables, P.fks);
  const total = tables.reduce((n, t) => n + P.data[t].rows.length, 0);
  console.log(`prod: ${tables.length} tables, ${total} rows`);

  const T = await snapshot(test, tables);
  if (mode === 'check') {
    console.table(tables.map((t) => ({
      table: t, prod: P.data[t].rows.length, test: T.data[t].rows.length,
      same: digest(P.data[t]) === digest(T.data[t]) ? 'yes' : '',
    })));
    console.log('CHECK ONLY -- nothing written. Run with "apply" to refresh.');
    return 0;
  }

  // 4a. Back up test.
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
  fs.mkdirSync(path.join(BACKEND, 'backups'), { recursive: true });
  const backupFile = path.join(BACKEND, 'backups', `test-pre-refresh-${stamp}.json`);
  fs.writeFileSync(backupFile, JSON.stringify({
    db: testUrl.replace(/^(libsql:\/\/[^.]+).*/, '$1'), taken_at: new Date().toISOString(), ...T,
  }));
  console.log(`test backup: ${backupFile} (${(fs.statSync(backupFile).size / 1024).toFixed(0)} KB)`);

  // 4b. Replace test's rows in one write transaction.
  const tx = await test.transaction('write');
  try {
    await tx.execute('PRAGMA defer_foreign_keys = ON');
    await tx.batch([...[...order].reverse().map((t) => `DELETE FROM ${q(t)}`), 'DELETE FROM sqlite_sequence']);

    for (const t of order) {
      const { cols, rows } = P.data[t];
      if (!rows.length) continue;
      const per = Math.max(1, Math.floor(MAX_PARAMS / cols.length));
      const head = `INSERT INTO ${q(t)} (${cols.map(q).join(', ')}) VALUES `;
      const tuple = `(${cols.map(() => '?').join(', ')})`;
      const stmts = [];
      for (let i = 0; i < rows.length; i += per) {
        const chunk = rows.slice(i, i + per);
        stmts.push({ sql: head + chunk.map(() => tuple).join(', '), args: chunk.flat() });
      }
      for (let i = 0; i < stmts.length; i += 40) await tx.batch(stmts.slice(i, i + 40));
      console.log(`  ${t}: ${rows.length}`);
    }

    // AUTOINCREMENT counters last: the inserts set them to max(id), and prod's
    // can be higher (deleted rows).
    await tx.execute('DELETE FROM sqlite_sequence');
    if (P.seq.length) {
      await tx.execute({
        sql: `INSERT INTO sqlite_sequence (name, seq) VALUES ${P.seq.map(() => '(?, ?)').join(', ')}`,
        args: P.seq.flatMap((s) => [s.name, s.seq]),
      });
    }

    const fk = (await tx.execute('PRAGMA foreign_key_check')).rows;
    if (fk.length) throw new Error(`foreign_key_check found ${fk.length} violations`);
    await tx.commit();
    console.log('COMMITTED');
  } catch (err) {
    await tx.rollback().catch(() => {});
    console.error(`ROLLED BACK -- test DB unchanged: ${err.message}`);
    return 1;
  } finally {
    tx.close();
  }

  // 5. Verify.
  const V = await snapshot(test, tables);
  const bad = tables.filter((t) => digest(V.data[t]) !== digest(P.data[t]));
  const seqSame = JSON.stringify(V.seq) === JSON.stringify(P.seq);
  const ic = (await test.execute('PRAGMA integrity_check')).rows.map((r) => Object.values(r)[0]);
  const fk = (await test.execute('PRAGMA foreign_key_check')).rows;
  console.log(`verify: ${tables.length - bad.length}/${tables.length} tables identical to prod | `
    + `sqlite_sequence ${seqSame ? 'identical' : 'DIFFERENT'} | integrity ${ic.join(',')} | FK violations ${fk.length}`);
  if (bad.length) console.log('  differing:', bad);
  return bad.length || !seqSame || fk.length || ic[0] !== 'ok' ? 1 : 0;
}

(async () => {
  const mode = process.argv[2] || 'check';
  if (!['check', 'apply'].includes(mode)) {
    console.error('usage: node scripts/refresh-test-from-prod.js [check|apply]');
    process.exitCode = 2;
    return;
  }

  const testEnv = envOf('.env');
  const prodEnv = envOf('.env.prod');
  const testUrl = testEnv.TURSO_DATABASE_URL || '';
  const prodUrl = prodEnv.TURSO_DATABASE_URL || '';
  if (!/^libsql:\/\/royalmart-roms-test-/.test(testUrl)) {
    console.error('Refusing: backend/.env does not point at royalmart-roms-test');
    process.exitCode = 1;
    return;
  }
  if (!/^libsql:\/\/royalmart-roms-royalmart/.test(prodUrl)) {
    console.error('Refusing: backend/.env.prod does not point at royalmart-roms (prod)');
    process.exitCode = 1;
    return;
  }

  const prod = createClient({ url: prodUrl, authToken: prodEnv.TURSO_AUTH_TOKEN });
  const test = createClient({ url: testUrl, authToken: testEnv.TURSO_AUTH_TOKEN });
  try {
    process.exitCode = await run(mode, prod, test, testUrl);
  } catch (err) {
    console.error(`FAILED: ${err.message}`);
    process.exitCode = 1;
  } finally {
    prod.close();
    test.close();
  }
})();
