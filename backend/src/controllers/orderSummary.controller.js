const db = require('../config/db');
const { logAction } = require('../services/auditLog.service');
const { buildPagination, buildOrderBy } = require('./marketplacePO.controller');

const VALID_VENDORS = ['Scootsy', 'Zepto', 'Blinkit'];
const VALID_STATUSES = ['Open', 'Closed'];

const SORT_COLUMNS = {
  po_id:              'p.po_id',
  vendor:             'p.vendor',
  vendor_po_id:       'p.vendor_po_id',
  city:               'p.city',
  status:             'p.status',
  po_date:            'p.po_date',
  po_expiry_date:     'p.po_expiry_date',
  dispatch_date:      'p.dispatch_date',
  tracking_id:        'p.tracking_id',
  courier_name:       'cr.name',
  updated_at:         'p.updated_at',
  office_poc_name:    'op.name',
  warehouse_poc_name: 'wp.name',
  updated_by_name:    'ub.name',
  line_count:         '(SELECT COUNT(*)            FROM marketplace_po_lines WHERE po_id = p.po_id)',
  total_qty:          '(SELECT COALESCE(SUM(qty),0) FROM marketplace_po_lines WHERE po_id = p.po_id)',
};

async function list(req, res, next) {
  try {
    const {
      po_id, vendor, vendor_po_id, city,
      po_date_from, po_date_to,
      dispatch_date_from, dispatch_date_to,
      status, office_poc, warehouse_poc,
      courier_id, has_tracking,
    } = req.query;

    const conditions = [];
    const args = [];
    if (po_id) { conditions.push('p.po_id LIKE ?'); args.push(`%${po_id}%`); }
    if (vendor && VALID_VENDORS.includes(vendor)) { conditions.push('p.vendor = ?'); args.push(vendor); }
    if (vendor_po_id) { conditions.push('p.vendor_po_id LIKE ?'); args.push(`%${vendor_po_id}%`); }
    if (city) { conditions.push('p.city = ?'); args.push(city); }
    if (po_date_from) { conditions.push('p.po_date >= ?'); args.push(po_date_from); }
    if (po_date_to)   { conditions.push('p.po_date <= ?'); args.push(po_date_to); }
    if (dispatch_date_from) { conditions.push('p.dispatch_date >= ?'); args.push(dispatch_date_from); }
    if (dispatch_date_to)   { conditions.push('p.dispatch_date <= ?'); args.push(dispatch_date_to); }
    if (status && VALID_STATUSES.includes(status)) { conditions.push('p.status = ?'); args.push(status); }
    if (office_poc === 'unassigned') {
      conditions.push('p.office_poc IS NULL');
    } else if (office_poc) {
      conditions.push('p.office_poc = ?'); args.push(Number(office_poc));
    }
    if (warehouse_poc === 'unassigned') {
      conditions.push('p.warehouse_poc IS NULL');
    } else if (warehouse_poc) {
      conditions.push('p.warehouse_poc = ?'); args.push(Number(warehouse_poc));
    }
    if (courier_id === 'unassigned') {
      conditions.push('p.courier_id IS NULL');
    } else if (courier_id) {
      conditions.push('p.courier_id = ?'); args.push(Number(courier_id));
    }
    if (has_tracking === 'yes') {
      conditions.push("p.tracking_id IS NOT NULL AND p.tracking_id != ''");
    } else if (has_tracking === 'no') {
      conditions.push("(p.tracking_id IS NULL OR p.tracking_id = '')");
    }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const orderBy = buildOrderBy(req.query, SORT_COLUMNS);
    const pag = buildPagination(req.query);

    const baseSelect = `
      SELECT p.po_id, p.vendor, p.vendor_po_id, p.po_date, p.po_expiry_date,
             p.city, p.status, p.dispatch_date,
             p.office_poc, p.warehouse_poc,
             p.courier_id, p.tracking_id,
             p.updated_by, p.updated_at,
             op.name AS office_poc_name,
             wp.name AS warehouse_poc_name,
             cr.name AS courier_name,
             ub.name AS updated_by_name,
             (SELECT COUNT(*)            FROM marketplace_po_lines WHERE po_id = p.po_id) AS line_count,
             (SELECT COALESCE(SUM(qty),0) FROM marketplace_po_lines WHERE po_id = p.po_id) AS total_qty
      FROM marketplace_pos p
      LEFT JOIN users op ON op.id = p.office_poc
      LEFT JOIN users wp ON wp.id = p.warehouse_poc
      LEFT JOIN couriers cr ON cr.id = p.courier_id
      LEFT JOIN users ub ON ub.id = p.updated_by
      ${where}
      ORDER BY ${orderBy}
    `;

    if (!pag.paginated) {
      const { rows } = await db.execute({ sql: baseSelect, args });
      return res.json({ rows, total: rows.length, page: 1, page_size: rows.length });
    }

    const [{ rows: pageRows }, { rows: countRows }] = await Promise.all([
      db.execute({ sql: `${baseSelect} LIMIT ? OFFSET ?`, args: [...args, pag.page_size, pag.offset] }),
      db.execute({ sql: `SELECT COUNT(*) AS total FROM marketplace_pos p ${where}`, args }),
    ]);
    res.json({
      rows: pageRows,
      total: Number(countRows[0]?.total) || 0,
      page: pag.page,
      page_size: pag.page_size,
    });
  } catch (err) { next(err); }
}

async function userHasRole(userId, role) {
  if (userId == null) return true;
  const { rows } = await db.execute({
    sql: 'SELECT 1 FROM user_roles WHERE user_id = ? AND role = ?',
    args: [Number(userId), role],
  });
  return rows.length > 0;
}

async function updateOne(req, res, next) {
  try {
    const { poId } = req.params;
    const { rows: existing } = await db.execute({
      sql: `SELECT po_id, vendor, status, dispatch_date, office_poc, warehouse_poc,
                   courier_id, tracking_id
            FROM marketplace_pos WHERE po_id = ?`,
      args: [poId],
    });
    if (!existing.length) return res.status(404).json({ message: 'PO not found' });
    const current = existing[0];

    const has = (k) => Object.prototype.hasOwnProperty.call(req.body, k);

    let officePoc = current.office_poc;
    if (has('office_poc')) {
      const v = req.body.office_poc;
      if (v != null) {
        const ok = await userHasRole(v, 'Office_POC');
        if (!ok) return res.status(400).json({ message: 'Selected user is not an Office_POC' });
      }
      officePoc = v == null ? null : Number(v);
    }
    let warehousePoc = current.warehouse_poc;
    if (has('warehouse_poc')) {
      const v = req.body.warehouse_poc;
      if (v != null) {
        const ok = await userHasRole(v, 'Warehouse_POC');
        if (!ok) return res.status(400).json({ message: 'Selected user is not a Warehouse_POC' });
      }
      warehousePoc = v == null ? null : Number(v);
    }

    let nextStatus = current.status;
    if (has('status')) {
      if (!VALID_STATUSES.includes(req.body.status)) {
        return res.status(400).json({ message: 'Invalid status' });
      }
      nextStatus = req.body.status;
    }

    let nextDispatchDate = current.dispatch_date;
    if (has('dispatch_date')) {
      const d = req.body.dispatch_date;
      if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) {
        return res.status(400).json({ message: 'Invalid dispatch_date format (expected YYYY-MM-DD)' });
      }
      nextDispatchDate = d || null;
    }

    let nextCourierId = current.courier_id;
    if (has('courier_id')) {
      const v = req.body.courier_id;
      if (v == null || v === '') {
        nextCourierId = null;
      } else {
        const n = Number(v);
        if (!Number.isInteger(n)) {
          return res.status(400).json({ message: 'Invalid courier_id' });
        }
        const { rows: cr } = await db.execute({
          sql: 'SELECT id FROM couriers WHERE id = ?',
          args: [n],
        });
        if (!cr.length) return res.status(400).json({ message: 'Courier not found' });
        nextCourierId = n;
      }
    }

    let nextTrackingId = current.tracking_id;
    let trackingDuplicateConfirmed = false;
    if (has('tracking_id')) {
      const t = req.body.tracking_id;
      nextTrackingId = (t == null || String(t).trim() === '') ? null : String(t).trim();

      // Two-tier duplicate check, run only when the tracking_id is non-empty
      // and changing. Clearing or no-op edits skip the check.
      if (nextTrackingId && nextTrackingId !== current.tracking_id) {
        // 1) Cross-vendor → hard error. Always blocks, even if the client
        //    sends confirm_duplicate_tracking.
        const { rows: crossVendor } = await db.execute({
          sql: `SELECT po_id, vendor_po_id, vendor, dispatch_date, tracking_id
                FROM marketplace_pos
                WHERE tracking_id = ?
                  AND vendor != ?
                  AND po_id != ?`,
          args: [nextTrackingId, current.vendor, poId],
        });
        if (crossVendor.length) {
          return res.status(409).json({
            error: 'tracking_id_vendor_conflict',
            severity: 'error',
            message: 'Tracking ID is already used by a different vendor.',
            tracking_id: nextTrackingId,
            conflicts: crossVendor,
          });
        }

        // 2) Same-vendor → soft warning. The client may override by re-sending
        //    with confirm_duplicate_tracking: true.
        const { rows: sameVendor } = await db.execute({
          sql: `SELECT po_id, vendor_po_id, vendor, dispatch_date, tracking_id
                FROM marketplace_pos
                WHERE tracking_id = ?
                  AND vendor = ?
                  AND po_id != ?`,
          args: [nextTrackingId, current.vendor, poId],
        });
        if (sameVendor.length) {
          if (!req.body.confirm_duplicate_tracking) {
            return res.status(409).json({
              error: 'tracking_id_duplicate_same_vendor',
              severity: 'warning',
              message: 'Tracking ID is already used on another PO for the same vendor.',
              tracking_id: nextTrackingId,
              duplicates: sameVendor,
            });
          }
          trackingDuplicateConfirmed = true;
        }
      }
    }

    if (nextStatus === 'Closed' && !nextDispatchDate) {
      return res.status(400).json({ message: 'Dispatch date is required to close an order' });
    }
    if (nextStatus === 'Open') {
      nextDispatchDate = null;
    }

    const tx = await db.transaction('write');
    try {
      await tx.execute({
        sql: `UPDATE marketplace_pos
              SET office_poc = ?, warehouse_poc = ?, status = ?, dispatch_date = ?,
                  courier_id = ?, tracking_id = ?,
                  updated_by = ?, updated_at = datetime('now')
              WHERE po_id = ?`,
        args: [officePoc, warehousePoc, nextStatus, nextDispatchDate, nextCourierId, nextTrackingId, req.user.id, poId],
      });
      await logAction({
        client: tx,
        userId: req.user.id,
        actionType: 'ORDER_SUMMARY_UPDATE',
        description: `Order Summary update on ${poId}: status=${nextStatus}, dispatch_date=${nextDispatchDate || '—'}, office_poc=${officePoc || '—'}, warehouse_poc=${warehousePoc || '—'}, courier_id=${nextCourierId || '—'}, tracking_id=${nextTrackingId || '—'}${trackingDuplicateConfirmed ? ' (duplicate tracking ID confirmed)' : ''}`,
        entityType: 'marketplace_po',
      });
      await tx.commit();
      res.json({ po_id: poId });
    } catch (e) {
      await tx.rollback();
      throw e;
    }
  } catch (err) { next(err); }
}

async function bulkUpdate(req, res, next) {
  try {
    const { po_ids, status, dispatch_date, courier_id } = req.body;
    if (!Array.isArray(po_ids) || po_ids.length === 0) {
      return res.status(400).json({ message: 'po_ids is required (non-empty array)' });
    }

    const has = (k) => Object.prototype.hasOwnProperty.call(req.body, k);
    const hasStatus   = has('status');
    const hasDispatch = has('dispatch_date');
    const hasCourier  = has('courier_id');
    if (!hasStatus && !hasDispatch && !hasCourier) {
      return res.status(400).json({ message: 'Provide at least one of status, dispatch_date, courier_id' });
    }

    if (hasStatus && !VALID_STATUSES.includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }
    if (hasDispatch && dispatch_date && !/^\d{4}-\d{2}-\d{2}$/.test(dispatch_date)) {
      return res.status(400).json({ message: 'Invalid dispatch_date format (expected YYYY-MM-DD)' });
    }
    if (hasStatus && status === 'Closed') {
      if (!dispatch_date || !/^\d{4}-\d{2}-\d{2}$/.test(dispatch_date)) {
        return res.status(400).json({ message: 'Dispatch date is required to close orders (YYYY-MM-DD)' });
      }
    }

    let courierIdValue = null;
    if (hasCourier) {
      if (courier_id == null || courier_id === '') {
        courierIdValue = null;
      } else {
        const n = Number(courier_id);
        if (!Number.isInteger(n)) {
          return res.status(400).json({ message: 'Invalid courier_id' });
        }
        const { rows: cr } = await db.execute({
          sql: 'SELECT id FROM couriers WHERE id = ?',
          args: [n],
        });
        if (!cr.length) return res.status(400).json({ message: 'Courier not found' });
        courierIdValue = n;
      }
    }

    const placeholders = po_ids.map(() => '?').join(',');
    const { rows: existing } = await db.execute({
      sql: `SELECT po_id FROM marketplace_pos WHERE po_id IN (${placeholders})`,
      args: po_ids,
    });
    if (existing.length !== po_ids.length) {
      const found = new Set(existing.map(r => r.po_id));
      const missing = po_ids.filter(id => !found.has(id));
      return res.status(404).json({ message: 'Some PO ids not found', missing });
    }

    const sets = [];
    const setArgs = [];
    if (hasStatus) {
      sets.push('status = ?');
      setArgs.push(status);
      // When closing, also stamp the dispatch_date. When re-opening, clear it.
      if (status === 'Closed') {
        sets.push('dispatch_date = ?');
        setArgs.push(dispatch_date);
      } else if (status === 'Open') {
        sets.push('dispatch_date = NULL');
      }
    } else if (hasDispatch) {
      sets.push('dispatch_date = ?');
      setArgs.push(dispatch_date || null);
    }
    if (hasCourier) {
      sets.push('courier_id = ?');
      setArgs.push(courierIdValue);
    }
    sets.push('updated_by = ?', "updated_at = datetime('now')");
    setArgs.push(req.user.id);

    const tx = await db.transaction('write');
    try {
      await tx.execute({
        sql: `UPDATE marketplace_pos SET ${sets.join(', ')} WHERE po_id IN (${placeholders})`,
        args: [...setArgs, ...po_ids],
      });
      const summary = po_ids.length <= 10 ? po_ids.join(',') : `${po_ids.length} orders`;
      const parts = [];
      if (hasStatus) parts.push(`status=${status}`);
      if (hasDispatch && !hasStatus) parts.push(`dispatch_date=${dispatch_date || '—'}`);
      if (hasCourier) parts.push(`courier_id=${courierIdValue || '—'}`);
      await logAction({
        client: tx,
        userId: req.user.id,
        actionType: 'ORDER_SUMMARY_BULK_UPDATE',
        description: `Bulk-updated ${po_ids.length} orders (${parts.join(', ')}): ${summary}`,
        entityType: 'marketplace_po',
      });
      await tx.commit();
      res.json({ updated: po_ids.length });
    } catch (e) {
      await tx.rollback();
      throw e;
    }
  } catch (err) { next(err); }
}

module.exports = { list, updateOne, bulkUpdate };
