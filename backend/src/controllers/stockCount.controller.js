const db = require('../config/db');
const { logAction } = require('../services/auditLog.service');
const { excludedItemNameSql } = require('../services/packagingExclusions');
const { isValidDateString } = require('../utils/dateValidation');
const { normOperator, operatorError, keyError, scanFieldsError } = require('../services/barcodeStation.service');
const {
  STATUS, IST_DATE, IST_TODAY,
  STATE_CTES, MISSED_CTES, COUNT_TOTALS_SELECT, EXPECTED_USE_SQL, UNLINKED_LINES_SQL,
} = require('../services/stockCount.service');

// Daily stock counts -- Barcode Station phase 2 (migrations 102, 103).
//
// THE COUNT IS THE IST DAY (103). Nobody starts or closes a count: the day's
// first scan creates its row, every scan that day joins it, and midnight IST
// finishes it. Every day with a scan is a full count.
//
// Two halves, two routers:
//   /api/station/counts/today...  the public station (station.routes.js,
//                           stationAuth): today's progress, and sending scans.
//                           The person at the PC is the typed `operator`, the
//                           audit user the barcode-station system user.
//   /api/stock/...          the portal (stockReports.routes.js, auth): stock and
//                           each day's results for everyone logged in, missed
//                           scans, the cross-check and sticker keys for
//                           Admin/Owner.
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
// which floor), and a row per scan would flood audit_logs. The day's first
// scan, which creates its count, is.

const COUNT_NOT_FOUND = 'Stock count not found';
const TODAY_IN_PROGRESS = "Today's count is still in progress — Out shows after midnight";

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

const COUNT_COLS = 'id, count_date, started_by, started_at';

const shapeCount = (r) => (r ? {
  id: num(r.id),
  count_date: r.count_date,
  started_by: r.started_by,
  started_at: r.started_at,
} : null);

// finished: the day is over (count_date before today, IST). Today's count has
// no Out figure yet -- out_packs is null, not 0.
const shapeTotals = (r) => ({
  ...shapeCount(r),
  seq: num(r.seq),
  finished: !!num(r.finished),
  found: num(r.found),
  new_packs: num(r.new_packs),
  out_packs: r.out_packs == null ? null : num(r.out_packs),
  flagged: num(r.flagged),
});

async function countTotals(id, client = db) {
  const { rows } = await client.execute({
    sql: `WITH ${STATE_CTES} SELECT * FROM (${COUNT_TOTALS_SELECT}) t WHERE t.id = ?`,
    args: [id],
  });
  return rows.length ? shapeTotals(rows[0]) : null;
}

// Today in IST, as the database sees it -- one clock for every write and read.
async function istToday(client = db) {
  return (await client.execute(`SELECT ${IST_TODAY} AS d`)).rows[0].d;
}

// The newest finished day's count, or null before Day 1 has finished.
async function lastFinished() {
  const { rows } = await db.execute(
    `SELECT ${COUNT_COLS} FROM stock_counts WHERE count_date < ${IST_TODAY} ORDER BY count_date DESC LIMIT 1`
  );
  return shapeCount(rows[0]);
}

// Today's count and how many packs it has so far, or null before the day's
// first scan.
async function todayCount() {
  const { rows } = await db.execute(
    `SELECT ${COUNT_COLS}, (SELECT COUNT(*) FROM stock_count_scans s WHERE s.count_id = c.id) AS scanned
       FROM stock_counts c WHERE c.count_date = ${IST_TODAY}`
  );
  return rows.length ? { ...shapeCount(rows[0]), scanned: num(rows[0].scanned) } : null;
}

// ===========================================================================
// STATION (stationAuth)
// ===========================================================================

// What is left to find today. Expected = every key that was not Out as of the
// last finished day (In Stock or Not yet counted), on the floor it was last
// seen on -- today's floor once it is found, its sticker's floor if it has
// never been counted. A pack that was
// Out is not expected -- if one turns up it is simply counted, and the
// expected figure does not move, so the station cannot tell it was Out.
// countId is today's count, or null before the day's first scan.
async function progressOf(countId) {
  const id = countId ?? 0;
  const [groups, scannedHere, floors, total] = await Promise.all([
    db.execute({
      sql: `WITH ${STATE_CTES},
              kf AS (SELECT s.label_key, MAX(c.seq) AS last_fin
                       FROM stock_count_scans s JOIN cc c ON c.id = s.count_id GROUP BY s.label_key),
              cur AS (SELECT label_key FROM stock_count_scans WHERE count_id = ?),
              exp AS (
                SELECT st.article_id, COALESCE(st.seen_floor_id, st.sticker_floor_id) AS floor_id,
                       (cur.label_key IS NOT NULL) AS found
                  FROM kstate st
                  LEFT JOIN kf ON kf.label_key = st.label_key
                  LEFT JOIN cur ON cur.label_key = st.label_key
                 WHERE kf.label_key IS NULL OR kf.last_fin = (SELECT seq FROM latest)
              )
            SELECT 'floor' AS dim, e.floor_id AS id, NULL AS label, COUNT(*) AS expected, SUM(e.found) AS found
              FROM exp e GROUP BY e.floor_id
            UNION ALL
            SELECT 'article', e.article_id, ${ARTICLE_LABEL_SQL('prm')}, COUNT(*), SUM(e.found)
              FROM exp e JOIN packaging_raw_materials prm ON prm.id = e.article_id
             GROUP BY e.article_id`,
      args: [id],
    }),
    db.execute({
      sql: 'SELECT floor_id, COUNT(*) AS n FROM stock_count_scans WHERE count_id = ? GROUP BY floor_id',
      args: [id],
    }),
    db.execute('SELECT id, name FROM floors'),
    db.execute({ sql: 'SELECT COUNT(*) AS n FROM stock_count_scans WHERE count_id = ?', args: [id] }),
  ]);

  const floorName = new Map(floors.rows.map((f) => [num(f.id), f.name]));
  const byFloor = new Map();
  const floorRow = (fid) => {
    if (!byFloor.has(fid)) byFloor.set(fid, { floor_id: fid, floor_name: floorName.get(fid) || '—', expected: 0, found: 0, scanned_here: 0 });
    return byFloor.get(fid);
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

// GET /api/station/counts/today -- today's count (null before the day's first
// scan) and what is left to find.
async function today(req, res, next) {
  try {
    const [day, count, last] = await Promise.all([istToday(), todayCount(), lastFinished()]);
    res.json({
      today: day,
      count,
      progress: await progressOf(count ? count.id : null),
      last_finished: last,
    });
  } catch (err) { next(err); }
}

// POST /api/station/counts/today/scans { operator, floor_id, keys } -- a batch
// of scans into TODAY's count, created by the day's first scan. Re-sending one
// is harmless: the PK (count_id, label_key) drops it.
async function scan(req, res, next) {
  try {
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
    let count = null;
    let inserted = new Set();
    try {
      // One clock for the whole batch, so a scan at midnight cannot straddle
      // two days.
      const day = await istToday(tx);
      // UNIQUE (count_date): two PCs sending the day's first scans at once
      // share one row.
      const created = (await tx.execute({
        sql: `INSERT INTO stock_counts (count_date, started_by) VALUES (?, ?)
              ON CONFLICT (count_date) DO NOTHING RETURNING ${COUNT_COLS}`,
        args: [day, operator],
      })).rows[0];
      count = shapeCount(created
        || (await tx.execute({ sql: `SELECT ${COUNT_COLS} FROM stock_counts WHERE count_date = ?`, args: [day] })).rows[0]);

      // From label_keys, so an unknown key inserts nothing. The WHERE also
      // settles SQLite's INSERT ... SELECT ... ON CONFLICT parsing ambiguity.
      const { rows } = await tx.execute({
        sql: `INSERT INTO stock_count_scans (count_id, label_key, floor_id, scanned_by)
              SELECT ?, k.label_key, ?, ? FROM label_keys k WHERE k.label_key IN (${marks})
              ON CONFLICT (count_id, label_key) DO NOTHING
              RETURNING label_key`,
        args: [count.id, floorId, operator, ...keys],
      });
      inserted = new Set(rows.map((r) => Number(r.label_key)));

      if (created && !inserted.size) {
        // Only unknown keys: no count for the day. An empty finished day would
        // mark every pack Out.
        await tx.rollback();
        count = null;
      } else {
        if (created) {
          await logAction({
            client: tx,
            userId: req.user.id,
            actionType: 'STOCK_COUNT_START',
            description: `${operator} started the stock count for ${day} (the day's first scan, on ${floor.name})`,
            entityType: 'stock_count',
            entityId: count.id,
          });
        }
        await tx.commit();
      }
    } catch (e) {
      await tx.rollback();
      throw e;
    }

    const [packs, total] = await Promise.all([
      db.execute({ sql: `SELECT k.label_key, ${PACK_COLS} FROM label_keys x ${PACK_JOINS('x.label_key')} WHERE x.label_key IN (${marks})`, args: keys }),
      count
        ? db.execute({ sql: 'SELECT COUNT(*) AS n FROM stock_count_scans WHERE count_id = ?', args: [count.id] })
        : { rows: [{ n: 0 }] },
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
    res.json({ results, scanned: num(total.rows[0].n), floor: { id: floorId, name: floor.name }, count });
  } catch (err) { next(err); }
}

// ===========================================================================
// PORTAL -- everyone logged in (no keys, no missed scans)
// ===========================================================================

// The floor a pack counts on in the stock reports: where it was last seen, or
// its sticker's floor if it has never been counted.
const STOCK_FLOOR = 'COALESCE(st.seen_floor_id, st.sticker_floor_id)';

// "Went Out on the last count": last seen on the day before the latest
// finished day, so Out on that day itself.
const OUT_LAST = `(st.status = '${STATUS.OUT}' AND st.last_seq = (SELECT seq FROM latest) - 1)`;

// ?vendor_id&floor_id, shared by /summary and the Admin sticker list so the
// download matches the page. Returns { conditions, args } or { error }.
function stockFilters(q) {
  const conditions = [];
  const args = [];
  for (const [param, col] of [['vendor_id', 'st.outbound_vendor_id'], ['floor_id', STOCK_FLOOR]]) {
    if (q[param] == null || q[param] === '') continue;
    const n = parseId(q[param]);
    if (n == null) return { error: `${param} must be a number` };
    conditions.push(`${col} = ?`);
    args.push(n);
  }
  return { conditions, args };
}

// GET /api/stock/summary?vendor_id&floor_id -- stock per article and floor.
// A pack sits on the floor it was last seen on (its sticker's floor if it has
// never been counted). In Stock already includes packs scanned today. "Out on
// the last count" is the latest FINISHED day's Out.
async function summary(req, res, next) {
  try {
    const { conditions, args, error } = stockFilters(req.query || {});
    if (error) return res.status(400).json({ message: error });
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const outLast = OUT_LAST;

    const [{ rows }, latest, todays] = await Promise.all([
      db.execute({
        sql: `WITH ${STATE_CTES}
              SELECT st.article_id, prm.category, prm.item_name, NULLIF(prm.variant, '') AS variant, prm.unit_metric,
                     ${STOCK_FLOOR} AS floor_id, f.name AS floor_name,
                     SUM(st.status = '${STATUS.IN_STOCK}') AS in_stock_packs,
                     SUM(CASE WHEN st.status = '${STATUS.IN_STOCK}' THEN st.pack_size ELSE 0 END) AS in_stock_pcs,
                     SUM(st.status = '${STATUS.NOT_COUNTED}') AS not_counted_packs,
                     SUM(CASE WHEN st.status = '${STATUS.NOT_COUNTED}' THEN st.pack_size ELSE 0 END) AS not_counted_pcs,
                     SUM(${outLast}) AS out_last_packs,
                     SUM(CASE WHEN ${outLast} THEN st.pack_size ELSE 0 END) AS out_last_pcs,
                     SUM(st.status = '${STATUS.IN_STOCK}' AND st.seen_floor_id <> st.sticker_floor_id) AS flagged_packs
                FROM kstate st
                JOIN packaging_raw_materials prm ON prm.id = st.article_id
                JOIN floors f ON f.id = ${STOCK_FLOOR}
                ${where}
               GROUP BY st.article_id, ${STOCK_FLOOR}
              HAVING SUM(st.status = '${STATUS.IN_STOCK}') + SUM(st.status = '${STATUS.NOT_COUNTED}') + SUM(${outLast}) > 0
               ORDER BY prm.category COLLATE NOCASE, prm.item_name COLLATE NOCASE, prm.variant COLLATE NOCASE, f.name COLLATE NOCASE`,
        args,
      }),
      lastFinished(),
      todayCount(),
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
      today: todays,
    });
  } catch (err) { next(err); }
}

// GET /api/stock/counts -- one row per day, newest first, with its totals.
// Today's row (finished: false) has found / new / flagged so far and no Out.
async function listCounts(req, res, next) {
  try {
    const pag = buildPagination(req.query || {});
    const [{ rows }, total, day] = await Promise.all([
      db.execute(`WITH ${STATE_CTES} SELECT * FROM (${COUNT_TOTALS_SELECT}) t ORDER BY t.count_date DESC ${limitSql(pag)}`),
      db.execute('SELECT COUNT(*) AS n FROM stock_counts'),
      istToday(),
    ]);
    res.json({ ...envelope(rows.map(shapeTotals), num(total.rows[0].n), pag), today: day });
  } catch (err) { next(err); }
}

async function loadCountOr404(id, res) {
  if (id == null) { res.status(404).json({ message: COUNT_NOT_FOUND }); return null; }
  const { rows } = await db.execute({
    sql: `SELECT ${COUNT_COLS}, (count_date < ${IST_TODAY}) AS finished FROM stock_counts WHERE id = ?`,
    args: [id],
  });
  if (!rows.length) { res.status(404).json({ message: COUNT_NOT_FOUND }); return null; }
  return { ...shapeCount(rows[0]), finished: !!num(rows[0].finished) };
}

// GET /api/stock/counts/:id -- one day's totals (today's so far).
async function getCount(req, res, next) {
  try {
    const count = await loadCountOr404(parseId(req.params.id), res);
    if (!count) return;
    res.json({ count: await countTotals(count.id) });
  } catch (err) { next(err); }
}

// The packs behind one of a day's totals, each with the floor it was seen on.
// `out`: last seen on the day before, never since -- finished days only.
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
    if (list === 'out' && !count.finished) return res.status(409).json({ message: TODAY_IN_PROGRESS });
    const pag = buildPagination(req.query || {});
    const ctes = `WITH ${STATE_CTES}, c AS (SELECT id, seq FROM days WHERE id = ?), sel AS (${PACK_LISTS[list]})`;
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

// GET /api/stock/missed -- per finished day: found, missed, and who scanned.
async function missedByCount(req, res, next) {
  try {
    const pag = buildPagination(req.query || {});
    const [{ rows }, total, all] = await Promise.all([
      db.execute(`WITH ${STATE_CTES}, ${MISSED_CTES},
                    mc AS (SELECT count_id, COUNT(*) AS n FROM missed GROUP BY count_id),
                    sc AS (SELECT count_id, COUNT(*) AS n, GROUP_CONCAT(DISTINCT scanned_by) AS operators
                             FROM stock_count_scans GROUP BY count_id)
                  SELECT cc.id, cc.seq, cc.count_date, cc.started_by, cc.started_at, sc.operators,
                         COALESCE(sc.n, 0) AS found, COALESCE(mc.n, 0) AS missed
                    FROM cc LEFT JOIN mc ON mc.count_id = cc.id LEFT JOIN sc ON sc.count_id = cc.id
                   ORDER BY cc.count_date DESC ${limitSql(pag)}`),
      db.execute(`SELECT COUNT(*) AS n FROM stock_counts WHERE count_date < ${IST_TODAY}`),
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

// GET /api/stock/missed/:id -- the packs missed on one day, with keys and the
// day each turned up again.
async function missedPacks(req, res, next) {
  try {
    const count = await loadCountOr404(parseId(req.params.id), res);
    if (!count) return;
    const pag = buildPagination(req.query || {});
    const ctes = `WITH ${STATE_CTES}, ${MISSED_CTES}, sel AS (SELECT * FROM missed WHERE count_id = ?)`;
    const [{ rows }, total] = await Promise.all([
      db.execute({
        sql: `${ctes}
              SELECT sel.label_key, sel.found_again_count_id, fa.count_date AS found_again_date, ${PACK_COLS}
                FROM sel ${PACK_JOINS('sel.label_key')}
                JOIN days fa ON fa.id = sel.found_again_count_id
               ORDER BY prm.category COLLATE NOCASE, prm.item_name COLLATE NOCASE, k.batch_id, k.label_no
               ${limitSql(pag)}`,
        args: [count.id],
      }),
      db.execute({ sql: `${ctes} SELECT COUNT(*) AS n FROM sel`, args: [count.id] }),
    ]);
    res.json(envelope(rows.map((r) => ({
      label_key: num(r.label_key),
      found_again_count_id: num(r.found_again_count_id),
      found_again_date: r.found_again_date,
      ...shapePack(r),
    })), num(total.rows[0].n), pag));
  } catch (err) { next(err); }
}

// GET /api/stock/cross-check?from&to -- per labelled article: pieces that went
// Out on finished days in the window, against what POs dispatched in the
// window should have used. Default window: the last 7 days (IST). A count's
// day is already an IST date, the same format as dispatch_date.
async function crossCheck(req, res, next) {
  try {
    const q = req.query || {};
    let { from, to } = q;
    if (!to) to = await istToday();
    if (!isValidDateString(to)) return res.status(400).json({ message: 'to must be a valid date (YYYY-MM-DD)' });
    if (!from) from = (await db.execute({ sql: "SELECT date(?, '-6 days') AS d", args: [to] })).rows[0].d;
    if (!isValidDateString(from)) return res.status(400).json({ message: 'from must be a valid date (YYYY-MM-DD)' });
    if (from > to) return res.status(400).json({ message: 'from cannot be after to' });

    const inWindow = 'c.count_date >= ? AND c.count_date <= ?';
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
      db.execute({ sql: `SELECT COUNT(*) AS n FROM stock_counts c WHERE c.count_date < ${IST_TODAY} AND ${inWindow}`, args: [from, to] }),
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
      counts_finished: num(counts.rows[0].n),
      unlinked_lines: num(unlinked.rows[0].n),
      rows,
      total: rows.length,
      page: 1,
      page_size: rows.length,
    });
  } catch (err) { next(err); }
}

// GET /api/stock/keys?vendor_id&floor_id -- ADMIN/OWNER: the packs behind the
// Current stock figures, one row per sticker WITH its key -- In stock (today's
// scans included), Not yet counted, and Went Out on the last count -- for the
// page's XLSX download. Same filters and floor rule as /summary, so each
// summary figure is the count of its rows here.
async function stickerList(req, res, next) {
  try {
    const { conditions, args, error } = stockFilters(req.query || {});
    if (error) return res.status(400).json({ message: error });
    const pag = buildPagination(req.query || {});
    const where = [
      `(st.status IN ('${STATUS.IN_STOCK}', '${STATUS.NOT_COUNTED}') OR ${OUT_LAST})`,
      ...conditions,
    ].join(' AND ');
    const from = `FROM kstate st ${PACK_JOINS('st.label_key')}
                  LEFT JOIN floors xf ON xf.id = st.seen_floor_id
                  LEFT JOIN days fd ON fd.seq = st.first_seq
                  LEFT JOIN days ld ON ld.seq = st.last_seq
                  LEFT JOIN cc od ON st.status = '${STATUS.OUT}' AND od.seq = st.last_seq + 1
                 WHERE ${where}`;
    const [{ rows }, total] = await Promise.all([
      db.execute({
        sql: `WITH ${STATE_CTES}
              SELECT st.label_key, st.status, st.article_id, ${STOCK_FLOOR} AS floor_id, ${PACK_COLS},
                     st.seen_floor_id, xf.name AS seen_floor_name,
                     fd.count_date AS first_seen, ld.count_date AS last_seen, od.count_date AS out_on,
                     ${IST_DATE('b.generated_at')} AS stickered_on
                ${from}
               ORDER BY prm.category COLLATE NOCASE, prm.item_name COLLATE NOCASE, prm.variant COLLATE NOCASE,
                        COALESCE(xf.name, sf.name) COLLATE NOCASE, k.batch_id, k.label_no
               ${limitSql(pag)}`,
        args,
      }),
      db.execute({ sql: `WITH ${STATE_CTES} SELECT COUNT(*) AS n ${from}`, args }),
    ]);
    res.json(envelope(rows.map((r) => {
      const pack = shapePack(r);
      return {
        label_key: num(r.label_key),
        status: r.status,
        article_id: num(r.article_id),
        floor_id: num(r.floor_id),
        ...pack,
        wrong_floor: r.status === STATUS.IN_STOCK && pack.seen_floor_id !== pack.sticker_floor_id,
        first_seen: r.first_seen ?? null,
        last_seen: r.last_seen ?? null,
        out_on: r.out_on ?? null,
        stickered_on: r.stickered_on ?? null,
      };
    }), num(total.rows[0].n), pag));
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
        sql: `SELECT s.count_id, c.count_date, s.floor_id, f.name AS floor_name, s.scanned_by, s.scanned_at
                FROM stock_count_scans s JOIN stock_counts c ON c.id = s.count_id JOIN floors f ON f.id = s.floor_id
               WHERE s.label_key = ? ORDER BY c.count_date`,
        args: [key],
      }),
      db.execute({
        sql: `WITH ${STATE_CTES}
              SELECT st.status, oc.id AS out_count_id, oc.count_date AS out_date
                FROM kstate st LEFT JOIN cc oc ON st.status = '${STATUS.OUT}' AND oc.seq = st.last_seq + 1
               WHERE st.label_key = ?`,
        args: [key],
      }),
      db.execute({
        sql: `WITH ${STATE_CTES}, ${MISSED_CTES}
              SELECT m.count_id, cc.count_date FROM missed m JOIN cc ON cc.id = m.count_id
               WHERE m.label_key = ? ORDER BY cc.count_date`,
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
      out_since: st.out_count_id ? { count_id: num(st.out_count_id), count_date: st.out_date } : null,
      sightings: sightings.rows.map((r) => ({
        count_id: num(r.count_id),
        count_date: r.count_date,
        floor_id: num(r.floor_id),
        floor_name: r.floor_name,
        scanned_by: r.scanned_by,
        scanned_at: r.scanned_at,
        floor_mismatch: num(r.floor_id) !== num(head.sticker_floor_id),
      })),
      missed_on: missed.rows.map((r) => ({ count_id: num(r.count_id), count_date: r.count_date })),
    });
  } catch (err) { next(err); }
}

module.exports = {
  // station (stationAuth)
  today, scan,
  // portal, everyone logged in
  summary, listCounts, getCount, countPacks,
  // portal, Admin/Owner
  missedByCount, missedPacks, crossCheck, stickerList, keyHistory,
};
