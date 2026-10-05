const db = require('../config/db');
const { logAction, diffFields } = require('../services/auditLog.service');
const { userHasRole } = require('../services/userRoles.service');
const { isValidDateString } = require('../utils/dateValidation');
const { buildPagination, buildOrderBy } = require('./marketplacePO.controller');
const {
  RTV_STATUSES, RTV_BOOKED, DN_DISPOSED, BLANK_STATUS, DELIVERED_VALUES,
  QUALIFIES_SQL, DN_SQL, EFFECTIVE_STATUS_SQL, rtvQualifies, effectiveStatus,
} = require('../services/rtv.service');

// RTV -- goods a marketplace sends back, tracked until they are in the warehouse
// or a credit note is in hand (migration 092). One row per marketplace PO that
// has ever qualified; the page shows those that qualify NOW. Everything but the
// RTV number and the fields typed on this page is read live off the PO.

// Twin of NONE_SELECTED elsewhere: a multi-select with nothing ticked.
const NONE_SELECTED = '__none_selected__';

// Free text references are held to the same rule as GRN Number on the GRN
// page: letters, digits and dashes.
const ALNUM = /^[A-Za-z0-9-]+$/;
const TEXT_MAX = 50;

const padSerial = (n) => String(n).padStart(3, '0');
const vendorLetter = (vendor) => String(vendor || '').charAt(0).toUpperCase();

const SORT_COLUMNS = {
  rtv_no: 'r.rtv_no',
  po_id: 'r.po_id',
  city: 'p.city',
  status: EFFECTIVE_STATUS_SQL,
  delivery_date: 'r.delivery_date',
  cn_date: 'r.cn_date',
  updated_at: 'r.updated_at',
};

// Make sure a qualifying PO has its RTV row, numbering it if this is the first
// time. Called inside the caller's transaction -- the GRN save that made the PO
// qualify -- so the PO and its RTV number land together or not at all. Returns
// the new row's rtv_no, or null when the PO already had one.
//
// The serial runs per first LETTER, so two vendors that share one can never
// collide on a number (the UNIQUE index would refuse it anyway).
async function ensureRtvRow(client, po, userId) {
  const { rows: existing } = await client.execute({
    sql: 'SELECT id FROM rtv_returns WHERE po_id = ?', args: [po.po_id],
  });
  if (existing.length) return null;
  const letter = vendorLetter(po.vendor);
  const { rows: maxRows } = await client.execute({
    sql: `SELECT MAX(CAST(SUBSTR(rtv_no, 3) AS INTEGER)) AS max_seq
            FROM rtv_returns WHERE SUBSTR(rtv_no, 1, 2) = ?`,
    args: [`${letter}R`],
  });
  const rtvNo = `${letter}R${padSerial((Number(maxRows[0]?.max_seq) || 0) + 1)}`;
  const { rows } = await client.execute({
    sql: `INSERT INTO rtv_returns (po_id, rtv_no, created_by, updated_by)
          VALUES (?, ?, ?, ?) RETURNING id`,
    args: [po.po_id, rtvNo, userId, userId],
  });
  await logAction({
    client,
    userId,
    actionType: 'RTV_CREATE',
    description: `RTV ${rtvNo} opened for PO ${po.po_id}`,
    entityType: 'rtv_return',
    entityId: rows[0].id,
  });
  return rtvNo;
}

// The WHERE clause list() and countsByVendor() share, so a tab badge can never
// disagree with the table under it. excludeVendor drops the vendor condition,
// which is what a per-vendor count is.
function buildWhere(query, { excludeVendor = false } = {}) {
  const conditions = [QUALIFIES_SQL];
  const args = [];

  if (query.vendor && !excludeVendor) { conditions.push('p.vendor = ?'); args.push(query.vendor); }

  // One box for every number someone might be holding: the RTV no, our PO id,
  // the vendor's PO no, the DN, either tracking id, or the credit note.
  const q = String(query.q || '').trim();
  if (q) {
    conditions.push(`(r.rtv_no LIKE ? OR r.po_id LIKE ? OR p.vendor_po_id LIKE ? OR ${DN_SQL} LIKE ?
      OR p.tracking_id LIKE ? OR r.inward_tracking_id LIKE ? OR r.cn_number LIKE ?)`);
    args.push(...Array(7).fill(`%${q}%`));
  }

  // Multi-select. BLANK_STATUS means "nobody has picked one yet" -- an
  // effective status of NULL.
  const statuses = String(query.status || '').split(',').map(s => s.trim()).filter(Boolean);
  if (statuses.includes(NONE_SELECTED)) {
    conditions.push('1 = 0');
  } else if (statuses.length) {
    const picked = statuses.filter(s => RTV_STATUSES.includes(s));
    const parts = [];
    if (picked.length) {
      parts.push(`${EFFECTIVE_STATUS_SQL} IN (${picked.map(() => '?').join(', ')})`);
      args.push(...picked);
    }
    if (statuses.includes(BLANK_STATUS)) parts.push(`${EFFECTIVE_STATUS_SQL} IS NULL`);
    conditions.push(parts.length ? `(${parts.join(' OR ')})` : '1 = 0');
  }

  if (query.city) { conditions.push('p.city = ?'); args.push(query.city); }
  if (query.inward_courier_id === 'unassigned') {
    conditions.push('r.inward_courier_id IS NULL');
  } else if (query.inward_courier_id) {
    conditions.push('r.inward_courier_id = ?'); args.push(Number(query.inward_courier_id));
  }
  if (query.cn_date_from) { conditions.push('r.cn_date >= ?'); args.push(query.cn_date_from); }
  if (query.cn_date_to) { conditions.push('r.cn_date <= ?'); args.push(query.cn_date_to); }
  if (query.delivery_date_from) { conditions.push('r.delivery_date >= ?'); args.push(query.delivery_date_from); }
  if (query.delivery_date_to) { conditions.push('r.delivery_date <= ?'); args.push(query.delivery_date_to); }

  return { where: `WHERE ${conditions.join(' AND ')}`, args };
}

const FROM = `
  FROM rtv_returns r
  JOIN marketplace_pos p ON p.po_id = r.po_id
  LEFT JOIN couriers cr ON cr.id = p.courier_id
  LEFT JOIN couriers ic ON ic.id = r.inward_courier_id
  LEFT JOIN users kb ON kb.id = r.checked_by
  LEFT JOIN users ub ON ub.id = r.updated_by`;

const SELECT = `
  SELECT r.id, r.rtv_no, r.po_id, p.vendor, p.vendor_po_id,
         p.grn_status, p.discrepancy_qty,
         -- RTV / DN: the GRN page's Discrepancy Number, or for a fully returned
         -- shipment (whose GRN DN is always cleared) the one typed here.
         p.discrepancy_number AS grn_dn, r.dn_number, ${DN_SQL} AS rtv_dn,
         p.tracking_id AS outward_tracking_id, cr.name AS outward_courier_name,
         p.bill_no,
         (SELECT COALESCE(SUM(qty), 0) FROM marketplace_po_lines WHERE po_id = p.po_id) AS po_qty,
         p.city,
         r.status AS stored_status, ${EFFECTIVE_STATUS_SQL} AS status,
         r.inward_courier_id, ic.name AS inward_courier_name, r.inward_tracking_id,
         r.delivered, r.delivery_date, r.cn_number, r.cn_date,
         r.checked_by, kb.name AS checked_by_name,
         r.created_at, r.updated_at, ub.name AS updated_by_name`;

// GET /api/rtv?vendor=Blinkit&q=&status=&city=&inward_courier_id=&cn_date_from=…
async function list(req, res, next) {
  try {
    const { where, args } = buildWhere(req.query);
    const orderBy = buildOrderBy(req.query, SORT_COLUMNS, 'r.rtv_no DESC');
    const pag = buildPagination(req.query);
    const sql = `${SELECT} ${FROM} ${where} ORDER BY ${orderBy}, r.id DESC`;

    if (!pag.paginated) {
      const { rows } = await db.execute({ sql, args });
      return res.json({ rows, total: rows.length, page: 1, page_size: rows.length });
    }
    const [{ rows }, { rows: countRows }] = await Promise.all([
      db.execute({ sql: `${sql} LIMIT ? OFFSET ?`, args: [...args, pag.page_size, pag.offset] }),
      db.execute({ sql: `SELECT COUNT(*) AS total ${FROM} ${where}`, args }),
    ]);
    res.json({ rows, total: Number(countRows[0]?.total) || 0, page: pag.page, page_size: pag.page_size });
  } catch (err) { next(err); }
}

// GET /api/rtv/counts-by-vendor -- the vendor tab badges, under every other filter.
async function countsByVendor(req, res, next) {
  try {
    const { where, args } = buildWhere(req.query, { excludeVendor: true });
    const { rows } = await db.execute({
      sql: `SELECT p.vendor, COUNT(*) AS count ${FROM} ${where} GROUP BY p.vendor`,
      args,
    });
    const counts = {};
    for (const r of rows) counts[r.vendor] = Number(r.count) || 0;
    res.json({ counts });
  } catch (err) { next(err); }
}

const RTV_FIELDS = ['dn_number', 'status', 'inward_courier_id', 'inward_tracking_id', 'delivered',
  'delivery_date', 'cn_number', 'cn_date', 'checked_by'];

// The fields after Status. 'DN - Disposed' means the marketplace disposed of the
// goods: nothing is coming back and no credit note follows, so every one of
// them is cleared (the page warns first, and the history keeps the old values).
const AFTER_STATUS = ['inward_courier_id', 'inward_tracking_id', 'delivered', 'delivery_date',
  'cn_number', 'cn_date', 'checked_by'];

const bad = (message) => Object.assign(new Error(message), { status: 400 });

function textRef(value, label) {
  if (value == null || String(value).trim() === '') return null;
  const s = String(value).trim();
  if (!ALNUM.test(s)) throw bad(`${label} must be alphanumeric (dashes allowed)`);
  if (s.length > TEXT_MAX) throw bad(`${label} must be ${TEXT_MAX} characters or less`);
  return s;
}

function dateField(value, label) {
  if (value == null || String(value).trim() === '') return null;
  const s = String(value).trim();
  if (!isValidDateString(s)) throw bad(`${label} is not a valid date`);
  return s;
}

// PATCH /api/rtv/:id -- the user-updatable columns, validated in column order.
async function update(req, res, next) {
  try {
    const { id } = req.params;
    const has = (k) => Object.prototype.hasOwnProperty.call(req.body || {}, k);
    const { rows: found } = await db.execute({
      sql: `SELECT r.*, p.vendor, p.status AS po_status, p.grn_status, p.discrepancy_qty,
                   p.discrepancy_number AS grn_dn
              FROM rtv_returns r JOIN marketplace_pos p ON p.po_id = r.po_id
             WHERE r.id = ?`,
      args: [id],
    });
    if (!found.length) return res.status(404).json({ message: 'RTV not found' });
    const current = found[0];
    if (!rtvQualifies({ status: current.po_status, grn_status: current.grn_status, discrepancy_qty: current.discrepancy_qty })) {
      return res.status(400).json({ message: `PO ${current.po_id} is no longer returned or short on the GRN page — this RTV is closed to edits` });
    }

    const row = Object.fromEntries(RTV_FIELDS.map(f => [f, current[f] ?? null]));
    try {
      // RTV / DN: typed here only for a row whose GRN DN is blank -- a fully
      // returned shipment. A discrepancy row's DN belongs to the GRN page.
      if (has('dn_number')) {
        const dn = textRef(req.body.dn_number, 'RTV / DN');
        if (dn && String(current.grn_dn ?? '').trim()) {
          throw bad('This row takes its DN from the GRN page — edit it there');
        }
        row.dn_number = dn;
      }
      if (has('status')) {
        const s = req.body.status == null || req.body.status === '' ? null : String(req.body.status).trim();
        if (s && !RTV_STATUSES.includes(s)) throw bad(`Status must be one of ${RTV_STATUSES.join(', ')}`);
        row.status = s;
      }
      if (has('inward_courier_id')) {
        const cid = req.body.inward_courier_id == null || req.body.inward_courier_id === ''
          ? null : Number(req.body.inward_courier_id);
        if (cid != null) {
          const { rows } = await db.execute({ sql: 'SELECT id, is_active FROM couriers WHERE id = ?', args: [cid] });
          if (!rows.length) throw bad('Inward Channel Partner not found');
          if (!rows[0].is_active && cid !== current.inward_courier_id) throw bad('Inward Channel Partner is inactive');
        }
        row.inward_courier_id = cid;
      }
      if (has('inward_tracking_id')) row.inward_tracking_id = textRef(req.body.inward_tracking_id, 'Inward Tracking ID');
      if (has('delivered')) {
        const d = req.body.delivered == null || req.body.delivered === '' ? null : String(req.body.delivered);
        if (d && !DELIVERED_VALUES.includes(d)) throw bad('Delivered must be Yes or No');
        row.delivered = d;
      }
      if (has('delivery_date')) row.delivery_date = dateField(req.body.delivery_date, 'Delivery Date');
      if (has('cn_number')) row.cn_number = textRef(req.body.cn_number, 'Credit Note Number');
      if (has('cn_date')) row.cn_date = dateField(req.body.cn_date, 'CN Date');
      if (has('checked_by')) {
        const uid = req.body.checked_by == null || req.body.checked_by === '' ? null : Number(req.body.checked_by);
        if (uid != null && uid !== current.checked_by && !(await userHasRole(uid, 'Warehouse_POC'))) {
          throw bad('Checked Warehouse POC must be a user tagged Warehouse_POC');
        }
        row.checked_by = uid;
      }
    } catch (e) {
      if (e.status === 400) return res.status(400).json({ message: e.message });
      throw e;
    }

    // Disposed: nothing comes back and no credit note follows.
    if (row.status === DN_DISPOSED) for (const f of AFTER_STATUS) row[f] = null;
    // A delivery date only means something once the goods are delivered.
    if (row.delivered !== 'Yes') row.delivery_date = null;

    // The rules that tie fields together, in column order.
    if (row.delivered === 'Yes' && !row.delivery_date) {
      return res.status(400).json({ message: 'Delivery Date is required when Delivered is Yes' });
    }
    if (row.status === RTV_BOOKED && !row.cn_number) {
      return res.status(400).json({ message: 'Credit Note Number is required when the status is RTV Booked' });
    }
    if (row.cn_number && !row.cn_date) {
      return res.status(400).json({ message: 'CN Date is required when a Credit Note Number is entered' });
    }

    const changes = diffFields(current, row, RTV_FIELDS);
    if (!changes.length) return res.json({ id: Number(id), changed: false });

    const tx = await db.transaction('write');
    try {
      await tx.execute({
        sql: `UPDATE rtv_returns
                 SET dn_number = ?, status = ?, inward_courier_id = ?, inward_tracking_id = ?,
                     delivered = ?, delivery_date = ?, cn_number = ?, cn_date = ?, checked_by = ?,
                     updated_by = ?, updated_at = datetime('now')
               WHERE id = ?`,
        args: [row.dn_number, row.status, row.inward_courier_id, row.inward_tracking_id,
          row.delivered, row.delivery_date, row.cn_number, row.cn_date, row.checked_by,
          req.user.id, id],
      });
      await logAction({
        client: tx,
        userId: req.user.id,
        actionType: 'RTV_UPDATE',
        description: `Updated RTV ${current.rtv_no} (PO ${current.po_id})`
          + (row.status === DN_DISPOSED && current.status !== DN_DISPOSED ? ' — marked DN - Disposed' : ''),
        entityType: 'rtv_return',
        entityId: Number(id),
        changes,
      });
      await tx.commit();
    } catch (e) { await tx.rollback(); throw e; }
    res.json({ id: Number(id), changed: true, status: effectiveStatus({ ...row, grn_dn: current.grn_dn }) });
  } catch (err) { next(err); }
}

module.exports = { list, countsByVendor, update, ensureRtvRow, textRef, NONE_SELECTED };
