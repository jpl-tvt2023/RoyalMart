// One-off, after migration 089: merge the multi-line challans already raised
// into Packing, Panchal or Third Party into ONE lot each, the shape every new
// challan into those stages now takes.
//
//   node src/migrations/merge-graded-challans.js           # dry run -- writes nothing
//   node src/migrations/merge-graded-challans.js --apply   # backup, then merge
//
// Check which database .env points at FIRST -- this runs against it.
//
// WHAT IT DOES. Before 089 a challan with a Fresh line and a Second line made
// two lots at its destination. For each such challan (same parent, challan no,
// party and stage, all live) the lowest-id line is kept and takes the summed
// quantities with the split in fresh/second/third_dozens. The other lines are
// soft-deleted with a revert_reason naming the keeper, so the Journey shows
// them as withdrawn rather than losing them, and each change is audited.
//
// WHAT IT SKIPS. A line that has anything live hanging off it (a challan or a
// write-off out of it) or that has been closed is left exactly as it is --
// merging it would re-parent material or rewrite a closed record. Skipped lines
// are listed with the reason. Reopen or withdraw first and run it again if the
// merge is wanted. A challan left with fewer than two eligible lines is skipped.
//
// It also REPORTS, without touching, the lots whose challans out of them name
// more than one party or carry more than one rate -- 089 left their Stage
// Party / Rate blank, and the first edit on them makes those challans one value.
//
// migrate.js only picks up *.sql, so this file is never run as a migration.
require('../config/env');
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@libsql/client');

const APPLY = process.argv.includes('--apply');
const GRADED = ['Packing', 'Panchal', 'Third Party'];
const GRADE_COLS = { Fresh: 'fresh_dozens', Second: 'second_dozens', Third: 'third_dozens' };

const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:./local.db',
  authToken: process.env.TURSO_AUTH_TOKEN || undefined,
});

const round2 = (n) => Math.round(n * 100) / 100;
// A sum that stays NULL when every part is NULL, like the columns it fills.
const sumOrNull = (rows, col) => (rows.every(r => r[col] == null)
  ? null : round2(rows.reduce((s, r) => s + (Number(r[col]) || 0), 0)));

(async () => {
  console.log(`Database: ${process.env.TURSO_DATABASE_URL}`);
  console.log(APPLY ? 'Mode: APPLY' : 'Mode: dry run (pass --apply to write)');

  const { rows: applied } = await db.execute(
    "SELECT filename FROM schema_migrations WHERE filename LIKE '089%'",
  );
  if (!applied.length) {
    console.log('Migration 089 is not applied here. Run npm run migrate first.');
    process.exitCode = 1;
    return;
  }

  const placeholders = GRADED.map(() => '?').join(',');
  const { rows: groups } = await db.execute({
    sql: `SELECT COALESCE(parent_receipt_id, -1) AS pr, COALESCE(parent_entry_id, -1) AS pe,
                 challan_no, party_name, stage, COUNT(*) AS n
            FROM stitching_entries
           WHERE deleted_at IS NULL AND write_off_reason IS NULL AND challan_no IS NOT NULL
             AND stage IN (${placeholders})
           GROUP BY 1, 2, 3, 4, 5
          HAVING COUNT(*) > 1`,
    args: GRADED,
  });

  const merges = [];
  const skipped = [];
  const touched = [];
  for (const g of groups) {
    const { rows: members } = await db.execute({
      sql: `SELECT e.*,
                   (SELECT COUNT(*) FROM stitching_entries c
                     WHERE c.parent_entry_id = e.id AND c.deleted_at IS NULL) AS live_children
              FROM stitching_entries e
             WHERE e.deleted_at IS NULL AND e.write_off_reason IS NULL
               AND e.stage = ? AND e.challan_no = ? AND e.party_name = ?
               AND COALESCE(e.parent_receipt_id, -1) = ? AND COALESCE(e.parent_entry_id, -1) = ?
             ORDER BY e.id`,
      args: [g.stage, g.challan_no, g.party_name, g.pr, g.pe],
    });
    touched.push(...members);
    const eligible = [];
    for (const m of members) {
      if (Number(m.live_children) > 0) skipped.push({ id: m.id, challan: g.challan_no, why: `${m.live_children} live row(s) out of it` });
      else if (m.closed_at) skipped.push({ id: m.id, challan: g.challan_no, why: 'closed' });
      else eligible.push(m);
    }
    if (eligible.length < 2) {
      if (eligible.length) skipped.push({ id: eligible[0].id, challan: g.challan_no, why: 'no other eligible line to merge with' });
      continue;
    }

    const [keeper, ...others] = eligible;
    const grades = Object.fromEntries(Object.values(GRADE_COLS).map(col => [
      col, round2(eligible.reduce((s, r) => s + (Number(r[col]) || 0), 0)),
    ]));
    const present = Object.entries(GRADE_COLS).filter(([, col]) => grades[col] > 0.005);
    const next = {
      sent_qty: sumOrNull(eligible, 'sent_qty'),
      received_qty: sumOrNull(eligible, 'received_qty'),
      sent_dozens: sumOrNull(eligible, 'sent_dozens'),
      received_dozens: sumOrNull(eligible, 'received_dozens'),
      ...grades,
      challan_type: present.length === 1 ? present[0][0] : null,
    };
    // A line with no challan_type (pre-080) has no grade column filled, so its
    // dozens would count in the total but in no grade. Said, not hidden.
    const gradeSum = round2(Object.values(grades).reduce((s, n) => s + n, 0));
    const warn = next.received_dozens != null && Math.abs(gradeSum - next.received_dozens) > 0.005
      ? ` (grades sum to ${gradeSum}, dozens ${next.received_dozens} -- a line had no type)` : '';
    merges.push({ keeper, others, next, label: `${g.stage} challan ${g.challan_no} / ${g.party_name}`, warn });
  }

  // Lots whose outgoing challans disagree -- report only.
  const { rows: disagreeing } = await db.execute(`
    SELECT 'entry' AS src, c.parent_entry_id AS lot_id,
           COUNT(DISTINCT c.party_name) AS parties, COUNT(DISTINCT c.process_rate) AS rates
      FROM stitching_entries c
     WHERE c.parent_entry_id IS NOT NULL AND c.deleted_at IS NULL AND c.write_off_reason IS NULL
     GROUP BY c.parent_entry_id
    HAVING COUNT(DISTINCT c.party_name) > 1 OR COUNT(DISTINCT c.process_rate) > 1
    UNION ALL
    SELECT 'receipt', c.parent_receipt_id,
           COUNT(DISTINCT c.party_name), COUNT(DISTINCT c.process_rate)
      FROM stitching_entries c
     WHERE c.parent_receipt_id IS NOT NULL AND c.deleted_at IS NULL AND c.write_off_reason IS NULL
     GROUP BY c.parent_receipt_id
    HAVING COUNT(DISTINCT c.party_name) > 1 OR COUNT(DISTINCT c.process_rate) > 1`);

  console.log(`
MULTI-LINE CHALLANS AT A GRADED STAGE   ${groups.length}
  to merge                              ${merges.length}  (removing ${merges.reduce((s, m) => s + m.others.length, 0)} line lot(s))
  lines skipped                         ${skipped.length}`);
  for (const m of merges) {
    console.log(`  merge  ${m.label}: keep #${m.keeper.id}, retire #${m.others.map(o => o.id).join(', #')}`
      + ` -> ${m.next.received_dozens} dz (F ${m.next.fresh_dozens} / S ${m.next.second_dozens} / T ${m.next.third_dozens})${m.warn}`);
  }
  for (const s of skipped) console.log(`  skip   #${s.id} (challan ${s.challan}): ${s.why}`);
  console.log(`
LOTS WHOSE CHALLANS DISAGREE (Stage Party / Rate left blank by 089)   ${disagreeing.length}`);
  for (const d of disagreeing) {
    console.log(`  ${d.src}:${d.lot_id}  ${d.parties} parties, ${d.rates} rates -- the first edit makes them one value`);
  }

  if (!APPLY || !merges.length) {
    if (!APPLY) console.log('\nDry run -- nothing written.');
    return;
  }

  // The backup: every line of every challan looked at, merged or not.
  const dir = path.resolve(__dirname, '../../backups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `pre-grade-merge-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify({ stitching_entries: touched }, null, 1));
  console.log(`\nBackup written: ${file}`);

  const audit = (tx, entityId, ref, description, changes) => tx.execute({
    sql: `INSERT INTO audit_logs (user_id, action_type, description, entity_type, entity_id, entity_ref, changes)
          VALUES (NULL, ?, ?, 'stitching_entry', ?, ?, ?)`,
    args: [changes ? 'STITCHING_ENTRY_UPDATE' : 'STITCHING_ENTRY_REVERT', description, entityId, ref ?? null,
      changes ? JSON.stringify(changes) : null],
  });

  const tx = await db.transaction('write');
  try {
    for (const m of merges) {
      const cols = Object.keys(m.next);
      const changes = cols
        .filter(c => String(m.keeper[c] ?? '') !== String(m.next[c] ?? ''))
        .map(c => ({ field: c, old: m.keeper[c], new: m.next[c] }));
      await tx.execute({
        sql: `UPDATE stitching_entries SET ${cols.map(c => `${c} = ?`).join(', ')},
                updated_at = datetime('now') WHERE id = ?`,
        args: [...cols.map(c => m.next[c]), m.keeper.id],
      });
      await audit(tx, m.keeper.id, m.keeper.challan_no,
        `Merged the lines of challan ${m.keeper.challan_no} into one ${m.keeper.stage} lot (one lot per challan, migration 089)`,
        changes);
      for (const o of m.others) {
        const reason = `Merged into lot #${m.keeper.id} (one lot per challan)`;
        await tx.execute({
          sql: `UPDATE stitching_entries SET deleted_at = datetime('now'), revert_reason = ?,
                  updated_at = datetime('now') WHERE id = ?`,
          args: [reason, o.id],
        });
        await audit(tx, o.id, o.challan_no, `Withdrew line ${o.challan_line_no} of challan ${o.challan_no} — ${reason}`, null);
      }
    }
    await tx.commit();
    console.log(`Merged ${merges.length} challan(s).`);
  } catch (err) {
    await tx.rollback();
    throw err;
  }
})()
  .catch(err => { console.error('Merge failed:', err.message); process.exitCode = 1; })
  .finally(() => db.close());
