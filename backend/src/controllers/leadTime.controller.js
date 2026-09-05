const db = require('../config/db');
const { buildPagination, buildOrderBy } = require('./marketplacePO.controller');

// The Lead Time Report covers every PO the GRN screen knows about, whatever its
// GRN status. Order Summary scopes that view with a single condition
// (p.status <> 'Deleted'), so carrying the same condition here keeps the two
// screens on identical populations. In-flight POs simply have NULL leads.

// Same expression the Order Summary / GRN views use, so status semantics stay in
// one shape across the app.
const COMPUTED_GRN_STATUS_SQL =
  "COALESCE(p.grn_status, CASE WHEN p.status = 'Closed' THEN 'Pending' ELSE 'Yet to Dispatch' END)";

// Which date column the From/To range filters on. Whitelisted — the query param
// is never interpolated directly.
const DATE_BASIS = {
  po_date:       'p.po_date',
  dispatch_date: 'p.dispatch_date',
  grn_date:      'p.grn_date',
};
const DEFAULT_BASIS = 'po_date';

// Dates are stored as 'YYYY-MM-DD' TEXT, so julianday() differences are exact
// whole days and timezone-free. A NULL on either side yields NULL, which is
// exactly the "blank cell" the report wants (e.g. RTV rows have no grn_date).
const DISPATCH_LEAD_SQL    = 'CAST(julianday(p.dispatch_date)    - julianday(p.po_date)       AS INTEGER)';
const GRN_LEAD_SQL         = 'CAST(julianday(p.grn_date)         - julianday(p.po_date)       AS INTEGER)';
const APPOINTMENT_LEAD_SQL = 'CAST(julianday(p.appointment_date) - julianday(p.dispatch_date) AS INTEGER)';

const TOTAL_QTY_SQL = '(SELECT COALESCE(SUM(qty), 0) FROM marketplace_po_lines WHERE po_id = p.po_id)';

// "Has this PO been received?" collapsed to three values. Everything still in
// flight ('Yet to Dispatch', 'Pending', 'Out For Delivery', 'Delivered - GRN
// Pending') is a plain 'No' — the common case now that the report is unfiltered.
const GRN_FLAG_SQL = `CASE ${COMPUTED_GRN_STATUS_SQL}
    WHEN 'Delivered - GRN Received' THEN 'Yes'
    WHEN 'Returned to Vendor'       THEN 'RTV'
    ELSE 'No'
  END`;

// Selectable values for the GRN Received? filter. Anything else (including the
// 'All' the UI sends for "no filter") leaves the flag unrestricted.
const GRN_FLAG_VALUES = ['Yes', 'RTV', 'No'];

const SORT_COLUMNS = {
  vendor:           'p.vendor',
  po_id:            'p.po_id',
  po_date:          'p.po_date',
  dispatch_date:    'p.dispatch_date',
  grn_date:         'p.grn_date',
  grn_qty:          'p.grn_qty',
  appointment_date: 'p.appointment_date',
  created_at:       'p.created_at',
  grn_flag:         GRN_FLAG_SQL,
  total_qty:        TOTAL_QTY_SQL,
  dispatch_lead:    DISPATCH_LEAD_SQL,
  grn_lead:         GRN_LEAD_SQL,
  appointment_lead: APPOINTMENT_LEAD_SQL,
};

function basisColumn(query) {
  return DATE_BASIS[String(query.date_basis || '')] || DATE_BASIS[DEFAULT_BASIS];
}

// Conditions that apply to every query on this page, minus the date range:
// soft-deleted POs never appear. 'All' (or an absent value) means no restriction
// on that filter. Everything downstream — the list, the summary, the medians,
// the excluded-rows count and the per-vendor counts — builds from here, so a
// filter added here applies consistently across all of them.
function baseConditions(query) {
  const conditions = ["p.status <> 'Deleted'"];
  const args = [];
  if (query.vendor && query.vendor !== 'All') {
    conditions.push('p.vendor = ?');
    args.push(query.vendor);
  }
  if (GRN_FLAG_VALUES.includes(query.grn_flag)) {
    conditions.push(`${GRN_FLAG_SQL} = ?`);
    args.push(query.grn_flag);
  }
  return { conditions, args };
}

// Full WHERE including the date range. A row whose basis column is NULL is
// dropped by the comparison (NULL >= '...' is NULL, not true) — that exclusion is
// intentional and is surfaced to the user via `excluded_no_date` below.
function buildWhere(query) {
  const { conditions, args } = baseConditions(query);
  const basis = basisColumn(query);
  if (query.date_from) { conditions.push(`${basis} >= ?`); args.push(query.date_from); }
  if (query.date_to)   { conditions.push(`${basis} <= ?`); args.push(query.date_to); }
  return { where: `WHERE ${conditions.join(' AND ')}`, args, basis };
}

// SQLite has no median aggregate. Window functions get there in one round trip:
// WHERE runs before the window functions, so NULL leads are dropped before
// numbering. Averaging rows (n+1)/2 and (n+2)/2 (integer division) picks the
// middle value for odd counts and the mean of the two middles for even counts.
function medianSql(leadExpr, where) {
  return `
    SELECT AVG(x) AS median FROM (
      SELECT lead AS x,
             ROW_NUMBER() OVER (ORDER BY lead) AS rn,
             COUNT(*)     OVER ()              AS n
      FROM (SELECT ${leadExpr} AS lead FROM marketplace_pos p ${where})
      WHERE lead IS NOT NULL
    ) WHERE rn IN ((n + 1) / 2, (n + 2) / 2)
  `;
}

const num = (v) => (v == null ? null : Number(v));

async function list(req, res, next) {
  try {
    const { where, args, basis } = buildWhere(req.query);
    const orderBy = buildOrderBy(req.query, SORT_COLUMNS, 'p.created_at DESC');
    const pag = buildPagination(req.query);

    const baseSelect = `
      SELECT p.vendor,
             p.po_id,
             p.po_date,
             p.dispatch_date,
             p.grn_date,
             p.grn_qty,
             p.appointment_date,
             p.created_at,
             ${GRN_FLAG_SQL}         AS grn_flag,
             ${TOTAL_QTY_SQL}        AS total_qty,
             ${DISPATCH_LEAD_SQL}    AS dispatch_lead,
             ${GRN_LEAD_SQL}         AS grn_lead,
             ${APPOINTMENT_LEAD_SQL} AS appointment_lead
      FROM marketplace_pos p
      ${where}
      ORDER BY ${orderBy}
    `;

    // Statistics cover the whole filtered set, not the visible page. AVG ignores
    // NULL leads, so each lead figure describes only the POs that carry both of
    // its dates — a much smaller slice than po_count now that in-flight POs are
    // in scope. COUNT(<expr>) also skips NULLs, so the *_lead_n counts are
    // exactly the sample each average is drawn from; the UI shows them so the
    // two numbers can't be mistaken for each other.
    const summarySql = `
      SELECT COUNT(*)                            AS po_count,
             COALESCE(SUM(${TOTAL_QTY_SQL}), 0)  AS total_qty,
             COALESCE(SUM(p.grn_qty), 0)         AS total_grn_qty,
             AVG(${DISPATCH_LEAD_SQL})           AS avg_dispatch_lead,
             AVG(${GRN_LEAD_SQL})                AS avg_grn_lead,
             AVG(${APPOINTMENT_LEAD_SQL})        AS avg_appointment_lead,
             COUNT(${DISPATCH_LEAD_SQL})         AS dispatch_lead_n,
             COUNT(${GRN_LEAD_SQL})              AS grn_lead_n,
             COUNT(${APPOINTMENT_LEAD_SQL})      AS appointment_lead_n
      FROM marketplace_pos p
      ${where}
    `;

    // How many in-scope POs the date range hid because they have no date on the
    // chosen basis. Only meaningful once a range is set.
    const hasRange = Boolean(req.query.date_from || req.query.date_to);
    let excludedSql = null;
    let excludedArgs = [];
    if (hasRange) {
      const ex = baseConditions(req.query);
      ex.conditions.push(`${basis} IS NULL`);
      excludedSql = `SELECT COUNT(*) AS total FROM marketplace_pos p WHERE ${ex.conditions.join(' AND ')}`;
      excludedArgs = ex.args;
    }

    const [summaryRes, dispatchMed, grnMed, apptMed, excludedRes] = await Promise.all([
      db.execute({ sql: summarySql, args }),
      db.execute({ sql: medianSql(DISPATCH_LEAD_SQL, where), args }),
      db.execute({ sql: medianSql(GRN_LEAD_SQL, where), args }),
      db.execute({ sql: medianSql(APPOINTMENT_LEAD_SQL, where), args }),
      excludedSql ? db.execute({ sql: excludedSql, args: excludedArgs }) : Promise.resolve({ rows: [] }),
    ]);

    const s = summaryRes.rows[0] || {};
    const summary = {
      po_count:                num(s.po_count) || 0,
      total_qty:               num(s.total_qty) || 0,
      total_grn_qty:           num(s.total_grn_qty) || 0,
      avg_dispatch_lead:       num(s.avg_dispatch_lead),
      avg_grn_lead:            num(s.avg_grn_lead),
      avg_appointment_lead:    num(s.avg_appointment_lead),
      median_dispatch_lead:    num(dispatchMed.rows[0]?.median),
      median_grn_lead:         num(grnMed.rows[0]?.median),
      median_appointment_lead: num(apptMed.rows[0]?.median),
      dispatch_lead_n:         num(s.dispatch_lead_n) || 0,
      grn_lead_n:              num(s.grn_lead_n) || 0,
      appointment_lead_n:      num(s.appointment_lead_n) || 0,
    };
    const excluded_no_date = Number(excludedRes.rows[0]?.total) || 0;

    if (!pag.paginated) {
      const { rows } = await db.execute({ sql: baseSelect, args });
      return res.json({ rows, total: rows.length, page: 1, page_size: rows.length, summary, excluded_no_date });
    }

    const { rows } = await db.execute({
      sql: `${baseSelect} LIMIT ? OFFSET ?`,
      args: [...args, pag.page_size, pag.offset],
    });
    // po_count over the same WHERE is the row total — no separate COUNT needed.
    res.json({
      rows,
      total: summary.po_count,
      page: pag.page,
      page_size: pag.page_size,
      summary,
      excluded_no_date,
    });
  } catch (err) { next(err); }
}

// Per-tab row counts. Mirrors the list filters (minus vendor, which is what we
// group by) so each tab's badge matches what that tab will show.
async function countsByVendor(req, res, next) {
  try {
    const { where, args } = buildWhere({ ...req.query, vendor: undefined });
    const { rows } = await db.execute({
      sql: `SELECT p.vendor, COUNT(*) AS count
            FROM marketplace_pos p
            ${where}
            GROUP BY p.vendor`,
      args,
    });
    const counts = {};
    let all = 0;
    for (const r of rows) {
      const n = Number(r.count) || 0;
      counts[r.vendor] = n;
      all += n;
    }
    counts.All = all;
    res.json({ counts });
  } catch (err) { next(err); }
}

module.exports = { list, countsByVendor };
