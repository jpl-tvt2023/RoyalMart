const db = require('../config/db');
const { logAction } = require('../services/auditLog.service');
const { userQualifiesAs } = require('../services/userRoles.service');
const { buildPagination, buildOrderBy } = require('./marketplacePO.controller');

const VALID_STATUSES = ['Open', 'Closed'];

const COMPUTED_GRN_STATUS_SQL =
  "COALESCE(p.grn_status, CASE WHEN p.status = 'Closed' THEN 'Pending' ELSE 'Yet to Dispatch' END)";

const GRN_STATUS_OPTIONS = [
  'Pending',
  'Out For Delivery',
  'Returned to Vendor',
  'Delivered - GRN Pending',
  'Delivered - GRN Received',
];
const GRN_STATUS_FILTER_VALUES = ['Yet to Dispatch', ...GRN_STATUS_OPTIONS];

const SORT_COLUMNS = {
  po_id:               'p.po_id',
  vendor:              'p.vendor',
  vendor_po_id:        'p.vendor_po_id',
  city:                'p.city',
  status:              'p.status',
  po_date:             'p.po_date',
  po_expiry_date:      'p.po_expiry_date',
  dispatch_date:       'p.dispatch_date',
  tracking_id:         'p.tracking_id',
  bill_no:             'p.bill_no',
  party_name:          'p.party_name',
  appointment_date:    'p.appointment_date',
  asn:                 'p.asn',
  grn_date:            'p.grn_date',
  grn_qty:             'p.grn_qty',
  grn_number:          'p.grn_number',
  discrepancy_qty:     'p.discrepancy_qty',
  discrepancy_number:  'p.discrepancy_number',
  note:                'p.note',
  computed_grn_status: COMPUTED_GRN_STATUS_SQL,
  courier_name:        'cr.name',
  updated_at:          'p.updated_at',
  office_poc_name:     'op.name',
  warehouse_poc_name:  'wp.name',
  updated_by_name:     'ub.name',
  line_count:          '(SELECT COUNT(*)            FROM marketplace_po_lines WHERE po_id = p.po_id)',
  total_qty:           '(SELECT COALESCE(SUM(qty),0) FROM marketplace_po_lines WHERE po_id = p.po_id)',
};

async function list(req, res, next) {
  try {
    const {
      po_id, vendor, vendor_po_id, city,
      po_date_from, po_date_to,
      dispatch_date_from, dispatch_date_to,
      status, office_poc, warehouse_poc,
      courier_id, has_tracking, tracking_id,
      bill_no,
      grn_status,
      appointment_date_from, appointment_date_to,
    } = req.query;

    const conditions = [];
    const args = [];
    if (po_id) { conditions.push('p.po_id LIKE ?'); args.push(`%${po_id}%`); }
    if (vendor) { conditions.push('p.vendor = ?'); args.push(vendor); }
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
    if (tracking_id) { conditions.push('p.tracking_id LIKE ?'); args.push(`%${tracking_id}%`); }
    if (bill_no) { conditions.push('p.bill_no LIKE ?'); args.push(`%${bill_no}%`); }
    if (grn_status && grn_status !== 'All' && GRN_STATUS_FILTER_VALUES.includes(grn_status)) {
      conditions.push(`${COMPUTED_GRN_STATUS_SQL} = ?`);
      args.push(grn_status);
    }
    if (appointment_date_from) { conditions.push('p.appointment_date >= ?'); args.push(appointment_date_from); }
    if (appointment_date_to)   { conditions.push('p.appointment_date <= ?'); args.push(appointment_date_to); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const orderBy = buildOrderBy(req.query, SORT_COLUMNS);
    const pag = buildPagination(req.query);

    const baseSelect = `
      SELECT p.po_id, p.vendor, p.vendor_po_id, p.po_date, p.po_expiry_date,
             p.city, p.status, p.dispatch_date,
             p.office_poc, p.warehouse_poc,
             p.courier_id, p.tracking_id,
             p.party_name, p.bill_no,
             p.appointment_date, p.asn, p.grn_status, p.grn_date,
             p.grn_qty, p.grn_number, p.discrepancy_qty, p.discrepancy_number,
             p.note,
             ${COMPUTED_GRN_STATUS_SQL} AS computed_grn_status,
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

async function updateOne(req, res, next) {
  try {
    const { poId } = req.params;
    const { rows: existing } = await db.execute({
      sql: `SELECT po_id, vendor, city, status, dispatch_date, office_poc, warehouse_poc,
                   courier_id, tracking_id, bill_no,
                   appointment_date, asn, grn_status, grn_date, grn_qty, grn_number,
                   discrepancy_qty, discrepancy_number, note
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
        const ok = await userQualifiesAs(v, 'Office_POC');
        if (!ok) return res.status(400).json({ message: 'Selected user is not an Office_POC' });
      }
      officePoc = v == null ? null : Number(v);
    }
    let warehousePoc = current.warehouse_poc;
    if (has('warehouse_poc')) {
      const v = req.body.warehouse_poc;
      if (v != null) {
        const ok = await userQualifiesAs(v, 'Warehouse_POC');
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
      if (d && d > new Date().toISOString().slice(0, 10)) {
        return res.status(400).json({ message: 'Dispatch date cannot be in the future' });
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

        // 2) Same vendor + different city (both non-null) → hard error.
        //    Tracking IDs are tied to a physical shipment and cannot legitimately
        //    serve two cities. Cannot be bypassed.
        if (current.city) {
          const { rows: cityConflict } = await db.execute({
            sql: `SELECT po_id, vendor_po_id, vendor, city, dispatch_date, tracking_id
                  FROM marketplace_pos
                  WHERE tracking_id = ?
                    AND vendor = ?
                    AND po_id != ?
                    AND city IS NOT NULL
                    AND city != ?`,
            args: [nextTrackingId, current.vendor, poId, current.city],
          });
          if (cityConflict.length) {
            return res.status(409).json({
              error: 'tracking_id_city_conflict',
              severity: 'error',
              message: 'Tracking ID is already used on a PO shipping to a different city for the same vendor.',
              tracking_id: nextTrackingId,
              conflicts: cityConflict,
            });
          }
        }

        // 3) Same vendor + same city (or either city null) → soft warning.
        //    The client may override by re-sending with confirm_duplicate_tracking.
        const { rows: sameVendor } = await db.execute({
          sql: `SELECT po_id, vendor_po_id, vendor, city, dispatch_date, tracking_id
                FROM marketplace_pos
                WHERE tracking_id = ?
                  AND vendor = ?
                  AND po_id != ?
                  AND (city = ? OR city IS NULL OR ? IS NULL)`,
          args: [nextTrackingId, current.vendor, poId, current.city, current.city],
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

    let nextBillNo = current.bill_no;
    if (has('bill_no')) {
      const b = req.body.bill_no;
      nextBillNo = (b == null || String(b).trim() === '') ? null : String(b).trim();
      if (nextBillNo && !/^[A-Za-z0-9-]+$/.test(nextBillNo)) {
        return res.status(400).json({ message: 'Bill no must be alphanumeric (dashes allowed)' });
      }
      if (nextBillNo && nextBillNo !== current.bill_no) {
        const { rows: dup } = await db.execute({
          sql: 'SELECT po_id, vendor, vendor_po_id FROM marketplace_pos WHERE bill_no = ? AND po_id != ?',
          args: [nextBillNo, poId],
        });
        if (dup.length) {
          return res.status(409).json({
            error: 'bill_no_duplicate',
            message: `Bill no "${nextBillNo}" is already used on PO ${dup[0].po_id}`,
            conflicts: dup,
          });
        }
      }
    }

    let nextAppointmentDate    = current.appointment_date;
    let nextAsn                = current.asn;
    let nextGrnStatus          = current.grn_status;
    let nextGrnDate            = current.grn_date;
    let nextGrnQty             = current.grn_qty;
    let nextGrnNumber          = current.grn_number;
    let nextDiscrepancyQty     = current.discrepancy_qty;
    let nextDiscrepancyNumber  = current.discrepancy_number;
    let nextNote               = current.note;

    const parseDateField = (val, label) => {
      if (val == null || String(val).trim() === '') return null;
      const s = String(val).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        const err = new Error(`Invalid ${label} format (expected YYYY-MM-DD)`);
        err.statusCode = 400;
        throw err;
      }
      return s;
    };
    const parseNonNegInt = (val, label) => {
      if (val == null || val === '') return null;
      const n = Number(val);
      if (!Number.isInteger(n) || n < 0) {
        const err = new Error(`${label} must be a non-negative integer`);
        err.statusCode = 400;
        throw err;
      }
      return n;
    };
    const parseAlphanumeric = (val, label) => {
      if (val == null || String(val).trim() === '') return null;
      const s = String(val).trim();
      if (!/^[A-Za-z0-9-]+$/.test(s)) {
        const err = new Error(`${label} must be alphanumeric (dashes allowed)`);
        err.statusCode = 400;
        throw err;
      }
      return s;
    };

    try {
      if (has('appointment_date')) nextAppointmentDate = parseDateField(req.body.appointment_date, 'appointment_date');
      if (has('asn')) {
        const a = req.body.asn;
        nextAsn = (a == null || String(a).trim() === '') ? null : String(a).trim();
      }
      if (has('grn_status')) {
        const g = req.body.grn_status;
        if (g == null || g === '') {
          nextGrnStatus = null;
        } else if (!GRN_STATUS_OPTIONS.includes(g)) {
          return res.status(400).json({ message: `Invalid grn_status. Allowed: ${GRN_STATUS_OPTIONS.join(', ')}` });
        } else if (current.status !== 'Closed') {
          return res.status(400).json({ message: 'Cannot set a GRN status — the PO has not been dispatched yet' });
        } else {
          nextGrnStatus = g;
        }
      }
      if (has('grn_date'))            nextGrnDate           = parseDateField(req.body.grn_date, 'grn_date');
      if (has('grn_qty'))             nextGrnQty            = parseNonNegInt(req.body.grn_qty, 'grn_qty');
      if (has('grn_number'))          nextGrnNumber         = parseAlphanumeric(req.body.grn_number, 'grn_number');
      if (has('discrepancy_qty'))     nextDiscrepancyQty    = parseNonNegInt(req.body.discrepancy_qty, 'discrepancy_qty');
      if (has('discrepancy_number'))  nextDiscrepancyNumber = parseAlphanumeric(req.body.discrepancy_number, 'discrepancy_number');
      if (has('note')) {
        const n = req.body.note;
        nextNote = (n == null || String(n).trim() === '') ? null : String(n).trim();
      }
    } catch (e) {
      if (e.statusCode === 400) return res.status(400).json({ message: e.message });
      throw e;
    }

    if (nextGrnStatus === 'Delivered - GRN Received') {
      const { rows: qtyRows } = await db.execute({
        sql: 'SELECT COALESCE(SUM(qty),0) AS po_qty FROM marketplace_po_lines WHERE po_id = ?',
        args: [poId],
      });
      const poQty = Number(qtyRows[0]?.po_qty || 0);
      if (!nextGrnDate) {
        return res.status(400).json({ message: 'GRN Date is required when status is "Delivered - GRN Received"' });
      }
      if (nextGrnQty == null || nextDiscrepancyQty == null) {
        return res.status(400).json({ message: 'GRN Qty and Discrepancy Qty are required when status is "Delivered - GRN Received"' });
      }
      if (nextGrnQty + nextDiscrepancyQty !== poQty) {
        return res.status(400).json({ message: `GRN Qty + Discrepancy Qty must equal PO Qty (${poQty})` });
      }
      if (!nextGrnNumber) {
        return res.status(400).json({ message: 'GRN Number is required' });
      }
      if (nextDiscrepancyQty > 0 && !nextDiscrepancyNumber) {
        return res.status(400).json({ message: 'Discrepancy Number is required when Discrepancy Qty > 0' });
      }
      if (nextDiscrepancyQty === 0) nextDiscrepancyNumber = null;
    }

    if (nextStatus === 'Closed') {
      const missing = [];
      if (!nextDispatchDate) missing.push('dispatch date');
      if (nextCourierId == null) missing.push('courier');
      if (!nextTrackingId) missing.push('tracking ID');
      if (missing.length) {
        return res.status(400).json({
          message: `Cannot close order — missing: ${missing.join(', ')}`,
        });
      }
    }
    if (nextStatus === 'Open') {
      nextDispatchDate = null;
      nextCourierId = null;
      nextTrackingId = null;
    }

    const tx = await db.transaction('write');
    try {
      await tx.execute({
        sql: `UPDATE marketplace_pos
              SET office_poc = ?, warehouse_poc = ?, status = ?, dispatch_date = ?,
                  courier_id = ?, tracking_id = ?, bill_no = ?,
                  appointment_date = ?, asn = ?, grn_status = ?, grn_date = ?,
                  grn_qty = ?, grn_number = ?, discrepancy_qty = ?, discrepancy_number = ?,
                  note = ?,
                  updated_by = ?, updated_at = datetime('now')
              WHERE po_id = ?`,
        args: [
          officePoc, warehousePoc, nextStatus, nextDispatchDate, nextCourierId, nextTrackingId, nextBillNo,
          nextAppointmentDate, nextAsn, nextGrnStatus, nextGrnDate,
          nextGrnQty, nextGrnNumber, nextDiscrepancyQty, nextDiscrepancyNumber,
          nextNote,
          req.user.id, poId,
        ],
      });
      await logAction({
        client: tx,
        userId: req.user.id,
        actionType: 'ORDER_SUMMARY_UPDATE',
        description: `Order Summary update on ${poId}: status=${nextStatus}, dispatch_date=${nextDispatchDate || '—'}, office_poc=${officePoc || '—'}, warehouse_poc=${warehousePoc || '—'}, courier_id=${nextCourierId || '—'}, tracking_id=${nextTrackingId || '—'}, bill_no=${nextBillNo || '—'}, appointment_date=${nextAppointmentDate || '—'}, asn=${nextAsn || '—'}, grn_status=${nextGrnStatus || '—'}, grn_date=${nextGrnDate || '—'}, grn_qty=${nextGrnQty == null ? '—' : nextGrnQty}, grn_number=${nextGrnNumber || '—'}, discrepancy_qty=${nextDiscrepancyQty == null ? '—' : nextDiscrepancyQty}, discrepancy_number=${nextDiscrepancyNumber || '—'}, note=${nextNote ? '"' + nextNote.slice(0, 60) + (nextNote.length > 60 ? '…' : '') + '"' : '—'}${trackingDuplicateConfirmed ? ' (duplicate tracking ID confirmed)' : ''}`,
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
    const { po_ids } = req.body;
    if (!Array.isArray(po_ids) || po_ids.length === 0) {
      return res.status(400).json({ message: 'po_ids is required (non-empty array)' });
    }

    const has = (k) => Object.prototype.hasOwnProperty.call(req.body, k);
    const hasOffice    = has('office_poc');
    const hasWarehouse = has('warehouse_poc');
    if (!hasOffice && !hasWarehouse) {
      return res.status(400).json({ message: 'Provide at least one of office_poc, warehouse_poc' });
    }

    let officePocValue = null;
    if (hasOffice) {
      const v = req.body.office_poc;
      if (v != null) {
        const ok = await userQualifiesAs(v, 'Office_POC');
        if (!ok) return res.status(400).json({ message: 'Selected user is not an Office_POC' });
        officePocValue = Number(v);
      }
    }
    let warehousePocValue = null;
    if (hasWarehouse) {
      const v = req.body.warehouse_poc;
      if (v != null) {
        const ok = await userQualifiesAs(v, 'Warehouse_POC');
        if (!ok) return res.status(400).json({ message: 'Selected user is not a Warehouse_POC' });
        warehousePocValue = Number(v);
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
    if (hasOffice) {
      sets.push('office_poc = ?');
      setArgs.push(officePocValue);
    }
    if (hasWarehouse) {
      sets.push('warehouse_poc = ?');
      setArgs.push(warehousePocValue);
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
      if (hasOffice) parts.push(`office_poc=${officePocValue ?? '—'}`);
      if (hasWarehouse) parts.push(`warehouse_poc=${warehousePocValue ?? '—'}`);
      await logAction({
        client: tx,
        userId: req.user.id,
        actionType: 'ORDER_SUMMARY_BULK_UPDATE',
        description: `Bulk-reassigned ${po_ids.length} orders (${parts.join(', ')}): ${summary}`,
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

async function countsByVendor(req, res, next) {
  try {
    const {
      po_id, vendor_po_id, city,
      po_date_from, po_date_to,
      dispatch_date_from, dispatch_date_to,
      status, office_poc, warehouse_poc,
      courier_id, has_tracking, tracking_id,
      bill_no,
      grn_status,
      appointment_date_from, appointment_date_to,
    } = req.query;

    const conditions = [];
    const args = [];
    if (po_id) { conditions.push('p.po_id LIKE ?'); args.push(`%${po_id}%`); }
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
    if (tracking_id) { conditions.push('p.tracking_id LIKE ?'); args.push(`%${tracking_id}%`); }
    if (bill_no) { conditions.push('p.bill_no LIKE ?'); args.push(`%${bill_no}%`); }
    if (grn_status && grn_status !== 'All' && GRN_STATUS_FILTER_VALUES.includes(grn_status)) {
      conditions.push(`${COMPUTED_GRN_STATUS_SQL} = ?`);
      args.push(grn_status);
    }
    if (appointment_date_from) { conditions.push('p.appointment_date >= ?'); args.push(appointment_date_from); }
    if (appointment_date_to)   { conditions.push('p.appointment_date <= ?'); args.push(appointment_date_to); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const { rows } = await db.execute({
      sql: `SELECT p.vendor, COUNT(*) AS count
            FROM marketplace_pos p
            ${where}
            GROUP BY p.vendor`,
      args,
    });
    const counts = {};
    for (const r of rows) counts[r.vendor] = Number(r.count) || 0;
    res.json({ counts });
  } catch (err) { next(err); }
}

async function grnAppointments(req, res, next) {
  try {
    const { date } = req.query;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ message: 'date is required (YYYY-MM-DD)' });
    }
    const { rows } = await db.execute({
      sql: `SELECT vendor,
                   COUNT(*) AS total,
                   COALESCE(SUM(CASE WHEN ${COMPUTED_GRN_STATUS_SQL} = 'Delivered - GRN Received' THEN 1 ELSE 0 END), 0) AS fulfilled
            FROM marketplace_pos p
            WHERE appointment_date = ?
              AND vendor IN ('Blinkit', 'Scootsy', 'Zepto')
            GROUP BY vendor
            ORDER BY vendor`,
      args: [date],
    });
    res.json({ date, rows });
  } catch (err) { next(err); }
}

module.exports = { list, updateOne, bulkUpdate, countsByVendor, grnAppointments };
