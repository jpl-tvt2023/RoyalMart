const db = require('../config/db');
const { logAction } = require('../services/auditLog.service');
const { excludedItemNameSql } = require('../services/packagingExclusions');
const { isValidDateString } = require('../utils/dateValidation');
const { normOperator, operatorError, keyError, scanFieldsError } = require('../services/barcodeStation.service');
const {
  STATUS, IST_DATE, IST_TODAY,
  STATE_CTES, MISSED_CTES, COUNT_TOTALS_SELECT, EXPECTED_USE_SQL, UNLINKED_LINES_SQL,
} = require('../services/stockCount.service');

// Daily stock counts -- Barcode Station phase 2 (migration 102).
//
// Two halves, two routers:
//   /api/station/counts...  the public station (station.routes.js, stationAuth):
//                           start a count, send scans, close it. The person at
//                           the PC is the typed `operator`, the audit user the
//                           barcode-station system user.
//   /api/stock/...          the portal (stockReports.routes.js, auth): stock and
//                           count results for everyone logged in, missed scans,
//                           the cross-check and sticker keys for Admin/Owner.
//
// The status rules -- In Stock, Out, Not yet counted, missed -- live in SQL in
// stockCount.service.js. Nothing here stores a status.
//
// WHAT THE STATION NEVER LEARNS: whether a pack was Out. A scan answers
// counted / already counted / unknown key, plus the pack and whether it is on
// the wrong floor. Missed scans are the scanner's mistakes, and only Admin/
// Owner see them.
//
// Scans are NOT audited one by one: the scan rows are the record (who, when,
// which floor), and a row per scan would flood audit_logs. Starting, closing
// and reopening a count are.

const COUNT_NOT_FOUND = 'Stock count not found';
const COUNT_CLOSED = 'This count is closed — start a new one';
const NOTHING_SCANNED = 'Scan at least one pack before closing the count';

const parseId = (v) => (/^\d+$/.test(String(v)) ? Number(v) : null);
const num = (v) => (v == null ? 0 : Number(v));

function buildPagination(query) {
  const rawPage = query.page;
  const rawSize = query.page_size;
  if (rawSize === 'all' || (rawPage == null && rawSize == null)) return { paginated: false };
  const page = Math.max(1, parseInt(rawPage, 10) || 1);
  const allowed = [10, 25, 50, 100];
  const requested = parseInt(rawSize, 10);
  const page_size = allowed.includes(requested) ? requested : 25;
  return { paginated: true, page, page_size, offset: (page - 1) * page_size };
}
const limitSql = (pag) => (pag.paginated ? `LIMIT ${pag.page_size} OFFSET ${pag.offset}` : '');
const envelope = (rows, total, pag) => ({
  rows, total, page: pag.paginated ? pag.page : 1, page_size: pag.paginated ? pag.page_size : rows.length,
});

const ARTICLE_LABEL_SQL = (a) => `${a}.category || ' · ' || ${a}.item_name || CASE WHEN ${a}.variant <> '' THEN ' · ' || ${a}.variant ELSE '' END`;
const articleLabel = (r) => `${r.category} · ${r.item_name}${r.variant ? ` · ${r.variant}` : ''}`;

// One pack, named the way everyone may see it: batch # and label no, never the
// key. `keyCol` is the SQL holding the label_key to join on.
const PACK_COLS = `
  k.batch_id, k.label_no, b.label_count, b.pack_size, v.name AS vendor_name,
  prm.category, prm.item_name, NULLIF(prm.variant, '') AS variant, prm.unit_metric,
  b.floor_id AS sticker_floor_id, sf.name AS sticker_floor_name`;
const PACK_JOINS = (keyCol) => `
  JOIN label_keys k               ON k.label_key = ${keyCol}
  JOIN label_batches b            ON b.id = k.batch_id
  JOIN outbound_vendors v         ON v.id = b.outbound_vendor_id
  JOIN packaging_raw_materials prm ON prm.id = b.article_id
  JOIN floors sf                  ON sf.id = b.floor_id`;

const shapePack = (r) => ({
  batch_id: num(r.batch_id),
  label_no: num(r.label_no),
  label_count: num(r.label_count),
  pack_size: num(r.pack_size),
  vendor_name: r.vendor_name,
  category: r.category,
  item_name: r.item_name,
  variant: r.variant,
  unit_metric: r.unit_metric,
  sticker_floor_id: num(r.sticker_floor_id),
  sticker_floor_name: r.sticker_floor_name,
  ...(r.seen_floor_id !== undefined && {
    seen_floor_id: r.seen_floor_id == null ? null : num(r.seen_floor_id),
    seen_floor_name: r.seen_floor_name ?? null,
  }),
});

const shapeCount = (r) => (r ? {
  id: num(r.id),
  started_by: r.started_by,
  started_at: r.started_at,
  closed_by: r.closed_by ?? null,
  closed_at: r.closed_at ?? null,
} : null);

const shapeTotals = (r) => ({
  ...shapeCount(r),
  seq: num(r.seq),
  found: num(r.found),
  new_packs: num(r.new_packs),
  out_packs: num(r.out_packs),
  flagged: num(r.flagged),
});

async function countTotals(id, client = db) {
  const { rows } = await client.execute({
    sql: `WITH ${STATE_CTES} SELECT * FROM (${COUNT_TOTALS_SELECT}) t WHERE t.id = ?`,
    args: [id],
  });
  return rows.length ? shapeTotals(rows[0]) : null;
}

// ===========================================================================
// STATION (stationAuth)
// ===========================================================================

// What is left to find on the open count: every key In Stock or Not yet
// counted is expected, on the floor it was last seen on (its sticker's floor
// if it has never been counted). Out packs are not expected -- if one turns up
// it is simply counted.
async function progressOf(countId) {
  const [groups, scannedHere, floors, total] = await Promise.all([
    db.execute({
      sql: `WITH ${STATE_CTES},
              cur AS (SELECT label_key FROM stock_count_scans WHERE count_id = ?),
              exp AS (
                SELECT st.article_id, COALESCE(st.seen_floor_id, st.sticker_floor_id) AS floor_id,
                       (cur.label_key IS NOT NULL) AS found
                  FROM kstate st LEFT JOIN cur ON cur.label_key = st.label_key
                 WHERE st.status IN ('${STATUS.IN_STOCK}', '${STATUS.NOT_COUNTED}')
              )
            SELECT 'floor' AS dim, e.floor_id AS id, NULL AS label, COUNT(*) AS expected, SUM(e.found) AS found
              FROM exp e GROUP BY e.floor_id
            UNION ALL
            SELECT 'article', e.article_id, ${ARTICLE_LABEL_SQL('prm')}, COUNT(*), SUM(e.found)
              FROM exp e JOIN packaging_raw_materials prm ON prm.id = e.article_id
             GROUP BY e.article_id`,
      args: [countId],
    }),
    db.execute({
      sql: 'SELECT floor_id, COUNT(*) AS n FROM stock_count_scans WHERE count_id = ? GROUP BY floor_id',
      args: [countId],
    }),
    db.execute('SELECT id, name FROM floors'),
    db.execute({ sql: 'SELECT COUNT(*) AS n FROM stock_count_scans WHERE count_id = ?', args: [countId] }),
  ]);

  const floorName = new Map(floors.rows.map((f) => [num(f.id), f.name]));
  const byFloor = new Map();
  const floorRow = (id) => {
    if (!byFloor.has(id)) byFloor.set(id, { floor_id: id, floor_name: floorName.get(id) || '—', expected: 0, found: 0, scanned_here: 0 });
    return byFloor.get(id);
  };
  const byArticle = [];
  for (const r of groups.rows) {
    if (r.dim === 'floor') {
      const f = floorRow(num(r.id));
      f.expected = num(r.expected);
      f.found = num(r.found);
    } else {
      byArticle.push({ article_id: num(r.id), article: r.label, expected: num(r.expected), found: num(r.found) });
    }
  }
  for (const r of scannedHere.rows) floorRow(num(r.floor_id)).scanned_here = num(r.n);

  const floorsOut = [...byFloor.values()]
    .map((f) => ({ ...f, to_go: f.expected - f.found }))
    .sort((a, b) => a.floor_name.localeCompare(b.floor_name));
  const articles = byArticle
    .map((a) => ({ ...a, to_go: a.expected - a.found }))
    .sort((a, b) => b.to_go - a.to_go || a.article.localeCompare(b.article));
  const expected = floorsOut.reduce((n, f) => n + f.expected, 0);
  const found = floorsOut.reduce((n, f) => n + f.found, 0);
  return {
    scanned: num(total.rows[0].n),
    expected,
    found,
    to_go: expected - found,
    by_floor: floorsOut,
    by_article: articles,
  };
}

async function lastClosed() {
  const { rows } = await db.execute(
    'SELECT id, started_by, started_at, closed_by, closed_at FROM stock_counts WHERE closed_at IS NOT NULL ORDER BY id DESC LIMIT 1'
  );
  return shapeCount(rows[0]);
}

// GET /api/station/counts/current -- the open count and what is left to find.
async function current(req, res, next) {
  try {
    const { rows } = await db.execute(
      'SELECT id, started_by, started_at, closed_by, closed_at FROM stock_counts WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1'
    );
    const last = await lastClosed();
    if (!rows.length) return res.json({ count: null, progress: null, last_closed: last });
    const count = shapeCount(rows[0]);
    res.json({ count, progress: await progressOf(count.id), last_closed: last });
  } catch (err) { next(err); }
}

// POST /api/station/counts { operator } -- start a count. One open at a time.
async function start(req, res, next) {
  try {
    const opErr = operatorError(req.body?.operator);
    if (opErr) return res.status(400).json({ message: opErr });
    const operator = normOperator(req.body.operator);

    const tx = await db.transaction('write');
    let created;
    let open;
    try {
      open = (await tx.execute('SELECT id, started_by, started_at FROM stock_counts WHERE closed_at IS NULL LIMIT 1')).rows[0];
      if (!open) {
        created = (await tx.execute({
          sql: 'INSERT INTO stock_counts (started_by) VALUES (?) RETURNING id, started_by, started_at, closed_by, closed_at',
          args: [operator],
        })).rows[0];
        await logAction({
          client: tx,
          userId: req.user.id,
          actionType: 'STOCK_COUNT_START',
          description: `${operator} started stock count #${created.id}`,
          entityType: 'stock_count',
          entityId: Number(created.id),
        });
        await tx.commit();
      } else {
        await tx.rollback();
      }
    } catch (e) {
      await tx.rollback();
      // The unique index is the backstop for two PCs starting at once.
      if (/UNIQUE constraint failed/i.test(e.message || '')) {
        return res.status(409).json({ message: 'A count is already open — carry on with it' });
      }
      throw e;
    }
    if (open) {
      return res.status(409).json({
        message: `Count #${open.id} is already open (started by ${open.started_by}) — carry on with it`,
        count: shapeCount(open),
      });
    }
    res.status(201).json({ count: shapeCount(created) });
  } catch (err) { next(err); }
}

// POST /api/station/counts/:id/scans { operator, floor_id, keys } -- a batch of
// scans. Re-sending one is harmless: the PK (count_id, label_key) drops it.
async function scan(req, res, next) {
  try {
    const id = parseId(req.params.id);
    if (id == null) return res.status(404).json({ message: COUNT_NOT_FOUND });
    const opErr = operatorError(req.body?.operator);
    if (opErr) return res.status(400).json({ message: opErr });
    const operator = normOperator(req.body.operator);
    const fieldsErr = scanFieldsError(req.body);
    if (fieldsErr) return res.status(400).json({ message: fieldsErr });
    const floorId = Number(req.body.floor_id);

    const floor = (await db.execute({ sql: 'SELECT name, is_active FROM floors WHERE id = ?', args: [floorId] })).rows[0];
    if (!floor) return res.status(400).json({ message: 'Floor not found' });
    if (!Number(floor.is_active)) return res.status(400).json({ message: `${floor.name} is no longer active — pick another floor` });

    // In the order sent, each key once.
    const keys = [...new Set(req.body.keys.map((k) => String(k).trim()))].map(Number);
    const marks = keys.map(() => '?').join(', ');

    const tx = await db.transaction('write');
    let inserted;
    try {
      const count = (await tx.execute({ sql: 'SELECT closed_at FROM stock_counts WHERE id = ?', args: [id] })).rows[0];
      if (!count || count.closed_at != null) {
        await tx.rollback();
        return res.status(count ? 409 : 404).json({ message: count ? COUNT_CLOSED : COUNT_NOT_FOUND });
      }
      // From label_keys, so an unknown key inserts nothing. The WHERE also
      // settles SQLite's INSERT ... SELECT ... ON CONFLICT parsing ambiguity.
      const { rows } = await tx.execute({
        sql: `INSERT INTO stock_count_scans (count_id, label_key, floor_id, scanned_by)
              SELECT ?, k.label_key, ?, ? FROM label_keys k WHERE k.label_key IN (${marks})
              ON CONFLICT (count_id, label_key) DO NOTHING
              RETURNING label_key`,
        args: [id, floorId, operator, ...keys],
      });
      inserted = new Set(rows.map((r) => Number(r.label_key)));
      await tx.commit();
    } catch (e) {
      await tx.rollback();
      throw e;
    }

    const [packs, total] = await Promise.all([
      db.execute({ sql: `SELECT k.label_key, ${PACK_COLS} FROM label_keys x ${PACK_JOINS('x.label_key')} WHERE x.label_key IN (${marks})`, args: keys }),
      db.execute({ sql: 'SELECT COUNT(*) AS n FROM stock_count_scans WHERE count_id = ?', args: [id] }),
    ]);
    const byKey = new Map(packs.rows.map((r) => [Number(r.label_key), shapePack(r)]));
    const results = keys.map((key) => {
      const pack = byKey.get(key);
      if (!pack) return { key: String(key), status: 'unknown' };
      return {
        key: String(key),
        status: inserted.has(key) ? 'counted' : 'already_counted',
        pack,
        floor_mismatch: pack.sticker_floor_id !== floorId,
      };
    });
    res.json({ results, scanned: num(total.rows[0].n), floor: { id: floorId, name: floor.name } });
  } catch (err) { next(err); }
}

// POST /api/station/counts/:id/close { operator } -- close the open count.
// From this moment every pack seen on the last count and not on this one is
// Out. A count with no scans cannot be closed: it would mark everything Out.
async function close(req, res, next) {
  try {
    const id = parseId(req.params.id);
    if (id == null) return res.status(404).json({ message: COUNT_NOT_FOUND });
    const opErr = operatorError(req.body?.operator);
    if (opErr) return res.status(400).json({ message: opErr });
    const operator = normOperator(req.body.operator);

    const tx = await db.transaction('write');
    let totals;
    try {
      const count = (await tx.execute({ sql: 'SELECT closed_at FROM stock_counts WHERE id = ?', args: [id] })).rows[0];
      if (!count || count.closed_at != null) {
        await tx.rollback();
        return res.status(count ? 409 : 404).json({ message: count ? 'This count is already closed' : COUNT_NOT_FOUND });
      }
      const scanned = num((await tx.execute({ sql: 'SELECT COUNT(*) AS n FROM stock_count_scans WHERE count_id = ?', args: [id] })).rows[0].n);
      if (!scanned) {
        await tx.rollback();
        return res.status(400).json({ message: NOTHING_SCANNED });
      }
      // Compare-and-set: a second click, or a second PC, closes nothing.
      const { rows } = await tx.execute({
        sql: `UPDATE stock_counts SET closed_at = datetime('now'), closed_by = ?
               WHERE id = ? AND closed_at IS NULL RETURNING id`,
        args: [operator, id],
      });
      if (!rows.length) {
        await tx.rollback();
        return res.status(409).json({ message: 'This count is already closed' });
      }
      totals = await countTotals(id, tx);
      await logAction({
        client: tx,
        userId: req.user.id,
        actionType: 'STOCK_COUNT_CLOSE',
        description: `${operator} closed stock count #${id}: ${totals.found} counted, ${totals.new_packs} new, `
          + `${totals.out_packs} not found (marked Out), ${totals.flagged} on the wrong floor`,
        entityType: 'stock_count',
        entityId: id,
      });
      await tx.commit();
    } catch (e) {
      await tx.rollback();
      throw e;
    }
    res.json({ count: totals });
  } catch (err) { next(err); }
}

// ===========================================================================
// PORTAL -- everyone logged in (no keys, no missed scans)
// ===========================================================================

// GET /api/stock/summary?vendor_id&floor_id -- stock per article and floor.
// A pack sits on the floor it was last seen on (its sticker's floor if it has
// never been counted).
async function summary(req, res, next) {
  try {
    const q = req.query || {};
    const conditions = [];
    const args = [];
    for (const [param, col] of [['vendor_id', 'st.outbound_vendor_id'], ['floor_id', 'COALESCE(st.seen_floor_id, st.sticker_floor_id)']]) {
      if (q[param] == null || q[param] === '') continue;
      const n = parseId(q[param]);
      if (n == null) return res.status(400).json({ message: `${param} must be a number` });
      conditions.push(`${col} = ?`);
      args.push(n);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const outLast = `st.status = '${STATUS.OUT}' AND st.last_seq = (SELECT seq FROM latest) - 1`;

    const [{ rows }, latest, open] = await Promise.all([
      db.execute({
        sql: `WITH ${STATE_CTES}
              SELECT st.article_id, prm.category, prm.item_name, NULLIF(prm.variant, '') AS variant, prm.unit_metric,
                     COALESCE(st.seen_floor_id, st.sticker_floor_id) AS floor_id, f.name AS floor_name,
                     SUM(st.status = '${STATUS.IN_STOCK}') AS in_stock_packs,
                     SUM(CASE WHEN st.status = '${STATUS.IN_STOCK}' THEN st.pack_size ELSE 0 END) AS in_stock_pcs,
                     SUM(st.status = '${STATUS.NOT_COUNTED}') AS not_counted_packs,
                     SUM(CASE WHEN st.status = '${STATUS.NOT_COUNTED}' THEN st.pack_size ELSE 0 END) AS not_counted_pcs,
                     SUM(${outLast}) AS out_last_packs,
                     SUM(CASE WHEN ${outLast} THEN st.pack_size ELSE 0 END) AS out_last_pcs,
                     SUM(st.status = '${STATUS.IN_STOCK}' AND st.seen_floor_id <> st.sticker_floor_id) AS flagged_packs
                FROM kstate st
                JOIN packaging_raw_materials prm ON prm.id = st.article_id
                JOIN floors f ON f.id = COALESCE(st.seen_floor_id, st.sticker_floor_id)
                ${where}
               GROUP BY st.article_id, COALESCE(st.seen_floor_id, st.sticker_floor_id)
              HAVING SUM(st.status = '${STATUS.IN_STOCK}') + SUM(st.status = '${STATUS.NOT_COUNTED}') + SUM(${outLast}) > 0
               ORDER BY prm.category COLLATE NOCASE, prm.item_name COLLATE NOCASE, prm.variant COLLATE NOCASE, f.name COLLATE NOCASE`,
        args,
      }),
      lastClosed(),
      db.execute('SELECT id, started_by, started_at FROM stock_counts WHERE closed_at IS NULL LIMIT 1'),
    ]);

    const shaped = rows.map((r) => ({
      article_id: num(r.article_id),
      category: r.category,
      item_name: r.item_name,
      variant: r.variant,
      unit_metric: r.unit_metric,
      floor_id: num(r.floor_id),
      floor_name: r.floor_name,
      in_stock_packs: num(r.in_stock_packs),
      in_stock_pcs: num(r.in_stock_pcs),
      not_counted_packs: num(r.not_counted_packs),
      not_counted_pcs: num(r.not_counted_pcs),
      out_last_packs: num(r.out_last_packs),
      out_last_pcs: num(r.out_last_pcs),
      flagged_packs: num(r.flagged_packs),
    }));
    const sum = (k) => shaped.reduce((n, r) => n + r[k], 0);
    res.json({
      rows: shaped,
      total: shaped.length,
      page: 1,
      page_size: shaped.length,
      totals: {
        in_stock_packs: sum('in_stock_packs'),
        in_stock_pcs: sum('in_stock_pcs'),
        not_counted_packs: sum('not_counted_packs'),
        out_last_packs: sum('out_last_packs'),
        out_last_pcs: sum('out_last_pcs'),
        flagged_packs: sum('flagged_packs'),
      },
      latest_count: latest,
      open_count: shapeCount(open.rows[0]),
    });
  } catch (err) { next(err); }
}

// GET /api/stock/counts -- closed counts, newest first, with their totals.
async function listCounts(req, res, next) {
  try {
    const pag = buildPagination(req.query || {});
    const [{ rows }, total, open] = await Promise.all([
      db.execute(`WITH ${STATE_CTES} SELECT * FROM (${COUNT_TOTALS_SELECT}) t ORDER BY t.id DESC ${limitSql(pag)}`),
      db.execute('SELECT COUNT(*) AS n FROM stock_counts WHERE closed_at IS NOT NULL'),
      db.execute(`SELECT c.id, c.started_by, c.started_at,
                         (SELECT COUNT(*) FROM stock_count_scans s WHERE s.count_id = c.id) AS scanned
                    FROM stock_counts c WHERE c.closed_at IS NULL LIMIT 1`),
    ]);
    const o = open.rows[0];
    res.json({
      ...envelope(rows.map(shapeTotals), num(total.rows[0].n), pag),
      open_count: o ? { ...shapeCount(o), scanned: num(o.scanned) } : null,
    });
  } catch (err) { next(err); }
}

async function loadCountOr404(id, res) {
  if (id == null) { res.status(404).json({ message: COUNT_NOT_FOUND }); return null; }
  const { rows } = await db.execute({ sql: 'SELECT id, started_by, started_at, closed_by, closed_at FROM stock_counts WHERE id = ?', args: [id] });
  if (!rows.length) { res.status(404).json({ message: COUNT_NOT_FOUND }); return null; }
  return shapeCount(rows[0]);
}

// GET /api/stock/counts/:id -- one count's totals. An open count has none yet.
async function getCount(req, res, next) {
  try {
    const count = await loadCountOr404(parseId(req.params.id), res);
    if (!count) return;
    if (!count.closed_at) {
      const n = (await db.execute({ sql: 'SELECT COUNT(*) AS n FROM stock_count_scans WHERE count_id = ?', args: [count.id] })).rows[0].n;
      return res.json({ count: { ...count, scanned: num(n) }, open: true });
    }
    res.json({ count: await countTotals(count.id), open: false });
  } catch (err) { next(err); }
}

// The packs behind one of a closed count's totals, each with the floor it was
// seen on. `out`: last seen on the count before, never since.
const PACK_LISTS = {
  found: `SELECT s.label_key, s.floor_id AS seen_floor_id FROM stock_count_scans s WHERE s.count_id = (SELECT id FROM c)`,
  new: `SELECT s.label_key, s.floor_id AS seen_floor_id
          FROM stock_count_scans s JOIN ks ON ks.label_key = s.label_key
         WHERE s.count_id = (SELECT id FROM c) AND ks.first_seq = (SELECT seq FROM c)`,
  out: `SELECT st.label_key, st.seen_floor_id FROM kstate st WHERE st.last_seq = (SELECT seq FROM c) - 1`,
  flagged: `SELECT s.label_key, s.floor_id AS seen_floor_id
              FROM stock_count_scans s
              JOIN label_keys k ON k.label_key = s.label_key
              JOIN label_batches b ON b.id = k.batch_id
             WHERE s.count_id = (SELECT id FROM c) AND s.floor_id <> b.floor_id`,
};

// GET /api/stock/counts/:id/packs?list=found|new|out|flagged
async function countPacks(req, res, next) {
  try {
    const count = await loadCountOr404(parseId(req.params.id), res);
    if (!count) return;
    const list = String(req.query.list || 'out');
    if (!PACK_LISTS[list]) return res.status(400).json({ message: 'list must be found, new, out or flagged' });
    if (!count.closed_at) return res.status(409).json({ message: 'This count is still open — its results appear once it is closed' });
    const pag = buildPagination(req.query || {});
    const ctes = `WITH ${STATE_CTES}, c AS (SELECT id, seq FROM cc WHERE id = ?), sel AS (${PACK_LISTS[list]})`;
    const [{ rows }, total] = await Promise.all([
      db.execute({
        sql: `${ctes}
              SELECT ${PACK_COLS}, sel.seen_floor_id, xf.name AS seen_floor_name
                FROM sel ${PACK_JOINS('sel.label_key')}
                LEFT JOIN floors xf ON xf.id = sel.seen_floor_id
               ORDER BY prm.category COLLATE NOCASE, prm.item_name COLLATE NOCASE, k.batch_id, k.label_no
               ${limitSql(pag)}`,
        args: [count.id],
      }),
      db.execute({ sql: `${ctes} SELECT COUNT(*) AS n FROM sel`, args: [count.id] }),
    ]);
    res.json(envelope(rows.map(shapePack), num(total.rows[0].n), pag));
  } catch (err) { next(err); }
}

// ===========================================================================
// PORTAL -- Admin/Owner only (stockReports.routes.js gates these)
// ===========================================================================

// POST /api/stock/counts/:id/reopen -- only the latest count, for one closed
// too early. Its scans are kept: the scanner carries on where he stopped.
async function reopen(req, res, next) {
  try {
    const count = await loadCountOr404(parseId(req.params.id), res);
    if (!count) return;
    const tx = await db.transaction('write');
    let done;
    try {
      const { rows } = await tx.execute({
        sql: `UPDATE stock_counts SET closed_at = NULL, closed_by = NULL
               WHERE id = ? AND closed_at IS NOT NULL AND id = (SELECT MAX(id) FROM stock_counts)
               RETURNING id`,
        args: [count.id],
      });
      done = rows.length > 0;
      if (done) {
        await logAction({
          client: tx,
          userId: req.user.id,
          actionType: 'STOCK_COUNT_REOPEN',
          description: `Reopened stock count #${count.id} (closed by ${count.closed_by})`,
          entityType: 'stock_count',
          entityId: count.id,
        });
        await tx.commit();
      } else {
        await tx.rollback();
      }
    } catch (e) {
      await tx.rollback();
      throw e;
    }
    if (!done) {
      return res.status(409).json({
        message: count.closed_at ? 'Only the latest count can be reopened' : 'This count is already open',
      });
    }
    res.json({ count: { ...count, closed_at: null, closed_by: null } });
  } catch (err) { next(err); }
}

// GET /api/stock/missed -- per closed count: found, missed, and who scanned.
async function missedByCount(req, res, next) {
  try {
    const pag = buildPagination(req.query || {});
    const [{ rows }, total, all] = await Promise.all([
      db.execute(`WITH ${STATE_CTES}, ${MISSED_CTES},
                    mc AS (SELECT count_id, COUNT(*) AS n FROM missed GROUP BY count_id),
                    sc AS (SELECT count_id, COUNT(*) AS n, GROUP_CONCAT(DISTINCT scanned_by) AS operators
                             FROM stock_count_scans GROUP BY count_id)
                  SELECT cc.id, cc.seq, cc.started_at, cc.closed_at, cc.closed_by, sc.operators,
                         COALESCE(sc.n, 0) AS found, COALESCE(mc.n, 0) AS missed
                    FROM cc LEFT JOIN mc ON mc.count_id = cc.id LEFT JOIN sc ON sc.count_id = cc.id
                   ORDER BY cc.id DESC ${limitSql(pag)}`),
      db.execute('SELECT COUNT(*) AS n FROM stock_counts WHERE closed_at IS NOT NULL'),
      db.execute(`WITH ${STATE_CTES}, ${MISSED_CTES} SELECT COUNT(*) AS n FROM missed`),
    ]);
    const shaped = rows.map((r) => {
      const found = num(r.found);
      const missed = num(r.missed);
      return {
        ...shapeCount(r),
        seq: num(r.seq),
        operators: r.operators ? String(r.operators).split(',') : [],
        found,
        missed,
        // Of the packs that were really there, the share he did not scan.
        miss_rate: found + missed ? Math.round((missed / (found + missed)) * 1000) / 10 : 0,
      };
    });
    res.json({ ...envelope(shaped, num(total.rows[0].n), pag), total_missed: num(all.rows[0].n) });
  } catch (err) { next(err); }
}

// GET /api/stock/missed/:id -- the packs missed on one count, with keys.
async function missedPacks(req, res, next) {
  try {
    const count = await loadCountOr404(parseId(req.params.id), res);
    if (!count) return;
    const pag = buildPagination(req.query || {});
    const ctes = `WITH ${STATE_CTES}, ${MISSED_CTES}, sel AS (SELECT * FROM missed WHERE count_id = ?)`;
    const [{ rows }, total] = await Promise.all([
      db.execute({
        sql: `${ctes}
              SELECT sel.label_key, sel.found_again_count_id, ${PACK_COLS}
                FROM sel ${PACK_JOINS('sel.label_key')}
               ORDER BY prm.category COLLATE NOCASE, prm.item_name COLLATE NOCASE, k.batch_id, k.label_no
               ${limitSql(pag)}`,
        args: [count.id],
      }),
      db.execute({ sql: `${ctes} SELECT COUNT(*) AS n FROM sel`, args: [count.id] }),
    ]);
    res.json(envelope(rows.map((r) => ({
      label_key: num(r.label_key),
      found_again_count_id: num(r.found_again_count_id),
      ...shapePack(r),
    })), num(total.rows[0].n), pag));
  } catch (err) { next(err); }
}

// GET /api/stock/cross-check?from&to -- per labelled article: pieces that went
// Out on counts closed in the window, against what POs dispatched in the
// window should have used. Default window: the last 7 days (IST).
async function crossCheck(req, res, next) {
  try {
    const q = req.query || {};
    let { from, to } = q;
    if (!to) to = (await db.execute(`SELECT ${IST_TODAY} AS d`)).rows[0].d;
    if (!isValidDateString(to)) return res.status(400).json({ message: 'to must be a valid date (YYYY-MM-DD)' });
    if (!from) from = (await db.execute({ sql: "SELECT date(?, '-6 days') AS d", args: [to] })).rows[0].d;
    if (!isValidDateString(from)) return res.status(400).json({ message: 'from must be a valid date (YYYY-MM-DD)' });
    if (from > to) return res.status(400).json({ message: 'from cannot be after to' });

    const inWindow = `${IST_DATE('c.closed_at')} >= ? AND ${IST_DATE('c.closed_at')} <= ?`;
    const [articles, outs, expected, unlinked, counts] = await Promise.all([
      // Every article with stickers. Corrugated and anything no SKU uses has no
      // expected figure (packagingExclusions.js keeps corrugated out of demand).
      db.execute(`SELECT prm.id, prm.category, prm.item_name, NULLIF(prm.variant, '') AS variant, prm.unit_metric,
                         ((EXISTS (SELECT 1 FROM product_packaging_requirements r WHERE r.packaging_raw_material_id = prm.id)
                           OR EXISTS (SELECT 1 FROM product_barcode_requirements r WHERE r.packaging_raw_material_id = prm.id))
                          AND ${excludedItemNameSql('prm')}) AS has_usage
                    FROM packaging_raw_materials prm
                   WHERE EXISTS (SELECT 1 FROM label_batches b WHERE b.article_id = prm.id AND b.generated_at IS NOT NULL)`),
      db.execute({
        sql: `WITH ${STATE_CTES}
              SELECT st.article_id, COUNT(*) AS packs, SUM(st.pack_size) AS pcs
                FROM kstate st JOIN cc c ON c.seq = st.last_seq + 1
               WHERE ${inWindow}
               GROUP BY st.article_id`,
        args: [from, to],
      }),
      db.execute({ sql: EXPECTED_USE_SQL, args: [from, to] }),
      db.execute({ sql: UNLINKED_LINES_SQL, args: [from, to] }),
      db.execute({ sql: `SELECT COUNT(*) AS n FROM stock_counts c WHERE c.closed_at IS NOT NULL AND ${inWindow}`, args: [from, to] }),
    ]);

    const outBy = new Map(outs.rows.map((r) => [num(r.article_id), { packs: num(r.packs), pcs: num(r.pcs) }]));
    const expBy = new Map(expected.rows.map((r) => [num(r.article_id), num(r.expected_pcs)]));
    const rows = articles.rows.map((a) => {
      const id = num(a.id);
      const out = outBy.get(id) || { packs: 0, pcs: 0 };
      const hasUsage = !!num(a.has_usage);
      const exp = hasUsage ? (expBy.get(id) || 0) : null;
      return {
        article_id: id,
        article: articleLabel(a),
        unit_metric: a.unit_metric,
        out_packs: out.packs,
        out_pcs: out.pcs,
        has_usage: hasUsage,
        expected_pcs: exp,
        gap_pcs: exp == null ? null : out.pcs - exp,
        gap_pct: exp ? Math.round(((out.pcs - exp) / exp) * 1000) / 10 : null,
      };
    }).sort((x, y) => (y.has_usage - x.has_usage) || Math.abs(y.gap_pcs || 0) - Math.abs(x.gap_pcs || 0) || x.article.localeCompare(y.article));

    res.json({
      from,
      to,
      counts_closed: num(counts.rows[0].n),
      unlinked_lines: num(unlinked.rows[0].n),
      rows,
      total: rows.length,
      page: 1,
      page_size: rows.length,
    });
  } catch (err) { next(err); }
}

// GET /api/stock/keys/:key -- one sticker's whole history.
async function keyHistory(req, res, next) {
  try {
    const raw = String(req.params.key || '').trim();
    const err = keyError(raw);
    if (err) return res.status(400).json({ message: err });
    const key = Number(raw);

    const head = (await db.execute({
      sql: `SELECT x.label_key, ${PACK_COLS}, b.generated_at, b.generated_by
              FROM label_keys x ${PACK_JOINS('x.label_key')} WHERE x.label_key = ?`,
      args: [key],
    })).rows[0];
    if (!head) return res.status(404).json({ message: `No label has the key ${raw}` });

    const [sightings, state, missed] = await Promise.all([
      db.execute({
        sql: `SELECT s.count_id, c.closed_at, s.floor_id, f.name AS floor_name, s.scanned_by, s.scanned_at
                FROM stock_count_scans s JOIN stock_counts c ON c.id = s.count_id JOIN floors f ON f.id = s.floor_id
               WHERE s.label_key = ? ORDER BY s.count_id`,
        args: [key],
      }),
      db.execute({
        sql: `WITH ${STATE_CTES}
              SELECT st.status, oc.id AS out_count_id, oc.closed_at AS out_closed_at
                FROM kstate st LEFT JOIN cc oc ON st.status = '${STATUS.OUT}' AND oc.seq = st.last_seq + 1
               WHERE st.label_key = ?`,
        args: [key],
      }),
      db.execute({
        sql: `WITH ${STATE_CTES}, ${MISSED_CTES}
              SELECT m.count_id, cc.closed_at FROM missed m JOIN cc ON cc.id = m.count_id
               WHERE m.label_key = ? ORDER BY m.count_id`,
        args: [key],
      }),
    ]);
    const st = state.rows[0];
    res.json({
      label_key: key,
      ...shapePack(head),
      generated_at: head.generated_at,
      generated_by: head.generated_by,
      status: st.status,
      out_since: st.out_count_id ? { count_id: num(st.out_count_id), closed_at: st.out_closed_at } : null,
      sightings: sightings.rows.map((r) => ({
        count_id: num(r.count_id),
        closed_at: r.closed_at ?? null,
        floor_id: num(r.floor_id),
        floor_name: r.floor_name,
        scanned_by: r.scanned_by,
        scanned_at: r.scanned_at,
        floor_mismatch: num(r.floor_id) !== num(head.sticker_floor_id),
      })),
      missed_on: missed.rows.map((r) => ({ count_id: num(r.count_id), closed_at: r.closed_at })),
    });
  } catch (err) { next(err); }
}

module.exports = {
  // station (stationAuth)
  current, start, scan, close,
  // portal, everyone logged in
  summary, listCounts, getCount, countPacks,
  // portal, Admin/Owner
  reopen, missedByCount, missedPacks, crossCheck, keyHistory,
};
