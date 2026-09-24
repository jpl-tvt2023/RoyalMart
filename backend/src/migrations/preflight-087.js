// Read-only preflight for migration 087. Run it against the database .env
// points at BEFORE `npm run migrate`:
//
//   node src/migrations/preflight-087.js
//
// It writes nothing to the database. It prints what 087 will do to the live
// rows, flags anything that would abort it or be approximated, and saves a JSON
// backup of every table 087 rebuilds into backups/ -- the same safety net the
// pre-082 backup was.
//
// migrate.js only picks up *.sql, so this file is never run as a migration.
require('../config/env');
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@libsql/client');

const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:./local.db',
  authToken: process.env.TURSO_AUTH_TOKEN || undefined,
});

const count = async (sql) => Number((await db.execute(sql)).rows[0].n) || 0;

(async () => {
  console.log(`Database: ${process.env.TURSO_DATABASE_URL}`);
  const { rows: applied } = await db.execute(
    "SELECT filename FROM schema_migrations WHERE filename LIKE '087%'",
  );
  if (applied.length) {
    console.log('087 is already applied here. Nothing to check.');
    return;
  }

  // 1. The guard. Any of these makes 087 roll back.
  const grayReceipts = await count(`SELECT COUNT(*) AS n FROM outbound_po_line_receipts r
    JOIN stitching_prefixes p ON p.id = r.incoming_prefix_id WHERE p.stage = 'Gray'`);
  const grayEntries = await count("SELECT COUNT(*) AS n FROM stitching_entries WHERE stage = 'Gray'");

  // 2. Rows whose dozens 087 has to back-compute from metres (rounded to 2dp).
  const convertedWriteOffs = await count(`SELECT COUNT(*) AS n FROM stitching_entries e
    LEFT JOIN stitching_entries pe ON pe.id = e.parent_entry_id
    LEFT JOIN outbound_po_line_receipts pr ON pr.id = e.parent_receipt_id
    LEFT JOIN stitching_prefixes psp ON psp.id = pr.incoming_prefix_id
    WHERE COALESCE(pe.stage, psp.stage) IN ('Stitched','Packed','Panchal','Third Party')
      AND (e.write_off_reason IS NOT NULL OR e.received_dozens IS NULL)`);

  // 3. Lots that will count dozens but have none recorded -- their balance
  //    would read as zero after 087 until someone fills the count in.
  const dozenLotsWithoutDozens = await count(`SELECT
      (SELECT COUNT(*) FROM stitching_entries WHERE deleted_at IS NULL AND write_off_reason IS NULL
         AND stage IN ('Stitched','Packed','Panchal','Third Party') AND received_dozens IS NULL)
    + (SELECT COUNT(*) FROM outbound_po_line_receipts r JOIN stitching_prefixes p ON p.id = r.incoming_prefix_id
         WHERE r.deleted_at IS NULL AND p.stage IN ('Stitched','Packed','Panchal') AND r.received_dozens IS NULL)
    AS n`);

  // 4. What changes meaning or state.
  const panchalReceiptsToClose = await count(`SELECT COUNT(*) AS n FROM outbound_po_line_receipts r
    JOIN stitching_prefixes p ON p.id = r.incoming_prefix_id
    WHERE p.stage = 'Panchal' AND r.closed_at IS NULL AND r.deleted_at IS NULL`);
  const perMetreRates = await count(`SELECT COUNT(*) AS n FROM stitching_entries
    WHERE process_rate IS NOT NULL AND stage NOT IN ('Stitched','Packed')`);
  const entries = await count('SELECT COUNT(*) AS n FROM stitching_entries');

  console.log(`
BLOCKERS (must be 0 or 087 rolls back)
  receipts at a Gray prefix (incl. deleted)  ${grayReceipts}
  stitching entries at Gray (incl. deleted)  ${grayEntries}

APPROXIMATED
  rows whose dozens are worked out from metres (2dp)   ${convertedWriteOffs}
  dozen-stage lots with no dozen count (balance -> 0)  ${dozenLotsWithoutDozens}

CHANGES
  stitching entries rebuilt                       ${entries}
  Panchal receipts closed by the migration        ${panchalReceiptsToClose}
  challan rates kept as per-metre (historical)    ${perMetreRates}
`);

  // The backup. Everything 087 rebuilds, plus the receipt columns it detaches
  // and reattaches, so any row can be put back by hand.
  const dump = {};
  for (const [key, sql] of Object.entries({
    stitching_entries: 'SELECT * FROM stitching_entries',
    stitching_prefixes: 'SELECT * FROM stitching_prefixes',
    stitching_party_uses: 'SELECT * FROM stitching_party_uses',
    stitching_parties: 'SELECT * FROM stitching_parties',
    receipt_prefix_and_close: 'SELECT id, incoming_prefix_id, closed_at, closed_by FROM outbound_po_line_receipts',
  })) {
    dump[key] = (await db.execute(sql)).rows;
  }
  const dir = path.resolve(__dirname, '../../backups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `pre-087-stitching-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(dump, null, 1));
  console.log(`Backup written: ${file}`);

  if (grayReceipts + grayEntries > 0) {
    console.log('\nNOT SAFE TO MIGRATE: resolve the Gray rows above first.');
    process.exitCode = 1;
  }
})()
  .catch(err => { console.error('Preflight failed:', err.message); process.exitCode = 1; })
  .finally(() => db.close());
