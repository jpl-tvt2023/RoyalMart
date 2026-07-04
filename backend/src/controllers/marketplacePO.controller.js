const db = require('../config/db');
const { logAction, diffFields } = require('../services/auditLog.service');
const { parse, hasParser } = require('../parsers/marketplacePO');

const VALID_STATUSES = ['Open', 'Closed'];

// Vendors whose POs carry a pre-agreed pickup date instead of an expiry date.
// For these the pickup date is mandatory at onboarding; every other vendor uses
// po_expiry_date. Since the two are mutually exclusive per vendor,
// COALESCE(pickup_date, po_expiry_date) yields the effective date for any PO.
const PICKUP_DATE_VENDORS = ['Amazon', 'Flipkart'];
const EFFECTIVE_EXPIRY_SQL = 'COALESCE(p.pickup_date, p.po_expiry_date)';

function pad3(n) { return String(n).padStart(3, '0'); }
function vendorPrefix(name) { return String(name || '').charAt(0).toUpperCase(); }

async function lookupActiveVendor(name) {
  if (!name) return null;
  const { rows } = await db.execute({
    sql: 'SELECT id, name, is_active, has_parser FROM vendors WHERE name = ?',
    args: [name],
  });
  return rows[0] || null;
}

// Attach internal_product_id/internal_sku_code to parsed preview lines by looking
// up this vendor's product_vendor_codes map (vendor_item_code → product). Lines
// aren't persisted yet, so we resolve in memory rather than via a join.
async function enrichLinesWithInternalSku(vendor, lines) {
  if (!Array.isArray(lines) || lines.length === 0) return lines || [];
  const { rows } = await db.execute({
    sql: `SELECT pvc.vendor_item_code, pr.id AS product_id, pr.sku_code
          FROM product_vendor_codes pvc
          JOIN products pr ON pr.id = pvc.product_id
          WHERE pvc.vendor = ?`,
    args: [vendor],
  });
  const byCode = new Map(rows.map(r => [String(r.vendor_item_code), r]));
  return lines.map(l => {
    const match = byCode.get(String(l.item_code));
    return {
      ...l,
      internal_product_id: match ? match.product_id : null,
      internal_sku_code: match ? match.sku_code : null,
    };
  });
}

async function parsePreview(req, res, next) {
  try {
    const { vendor } = req.body;
    const v = await lookupActiveVendor(vendor);
    if (!v || !v.is_active) {
      return res.status(400).json({ message: 'Unknown vendor. Add it under Configurations first.' });
    }
    if (!hasParser(vendor)) {
      return res.status(400).json({
        error: 'vendor_parser_not_implemented',
        message: `Currently there is no logic implemented for vendor "${vendor}". Please connect with your admin.`,
        vendor,
      });
    }
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ message: 'File is required' });
    }

    let parsed;
    try {
      parsed = await parse(vendor, req.file.buffer);
    } catch (err) {
      return res.status(400).json({ message: `Parse failed: ${err.message}` });
    }

    // Enrich preview lines with the internal SKU so the user sees it BEFORE
    // approval (mirrors the join getOne() runs post-save). Single lookup of this
    // vendor's code→product map, then attach per line.
    parsed.lines = await enrichLinesWithInternalSku(vendor, parsed.lines);

    // City is intentionally not extracted from the file — the user selects it
    // manually during the preview phase (vendor addresses are unreliable).
    parsed.city = null;

    await logAction({
      userId: req.user.id,
      actionType: 'MARKETPLACE_PO_PARSE',
      description: `Parsed ${vendor} PO ${parsed.vendor_po_id} (${parsed.lines.length} lines)`,
      entityType: 'marketplace_po',
    });

    res.json({ vendor, ...parsed });
  } catch (err) { next(err); }
}

const PO_SORT_COLUMNS = {
  po_id:             'p.po_id',
  vendor:            'p.vendor',
  vendor_po_id:      'p.vendor_po_id',
  city:              'p.city',
  status:            'p.status',
  po_date:           'p.po_date',
  po_expiry_date:    'p.po_expiry_date',
  pickup_date:       'p.pickup_date',
  expiry_or_pickup:  EFFECTIVE_EXPIRY_SQL,
  updated_at:        'p.updated_at',
  onboarded_by_name: 'ob.name',
  updated_by_name:   'ub.name',
  line_count:        '(SELECT COUNT(*)            FROM marketplace_po_lines WHERE po_id = p.po_id)',
  total_qty:         '(SELECT COALESCE(SUM(qty),0) FROM marketplace_po_lines WHERE po_id = p.po_id)',
};

function buildPagination(query) {
  const rawPage = query.page;
  const rawSize = query.page_size;
  if (rawSize === 'all' || (rawPage == null && rawSize == null)) {
    return { paginated: false };
  }
  const page = Math.max(1, parseInt(rawPage, 10) || 1);
  const allowed = [10, 25, 50, 100];
  const requested = parseInt(rawSize, 10);
  const page_size = allowed.includes(requested) ? requested : 25;
  return { paginated: true, page, page_size, offset: (page - 1) * page_size };
}

function buildOrderBy(query, columnMap, defaultExpr = 'p.updated_at DESC') {
  const key = query.sort_by;
  const dir = String(query.sort_dir || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  if (key && columnMap[key]) return `${columnMap[key]} ${dir}`;
  return defaultExpr;
}

async function list(req, res, next) {
  try {
    const {
      po_id, vendor, vendor_po_id, city, sku_code,
      po_date_from, po_date_to,
      po_expiry_date_from, po_expiry_date_to,
      status,
    } = req.query;
    const conditions = [];
    const args = [];
    if (po_id) { conditions.push('p.po_id LIKE ?'); args.push(`%${po_id}%`); }
    if (vendor) { conditions.push('p.vendor = ?'); args.push(vendor); }
    if (vendor_po_id) { conditions.push('p.vendor_po_id LIKE ?'); args.push(`%${vendor_po_id}%`); }
    if (city) { conditions.push('p.city = ?'); args.push(city); }
    if (po_date_from) { conditions.push('p.po_date >= ?'); args.push(po_date_from); }
    if (po_date_to)   { conditions.push('p.po_date <= ?'); args.push(po_date_to); }
    // Expiry filters run against the effective date so Amazon/Flipkart pickup
    // dates are caught by the same "expiring/expired" queries as expiry dates.
    if (po_expiry_date_from) { conditions.push(`${EFFECTIVE_EXPIRY_SQL} >= ?`); args.push(po_expiry_date_from); }
    if (po_expiry_date_to)   { conditions.push(`${EFFECTIVE_EXPIRY_SQL} <= ?`); args.push(po_expiry_date_to); }
    if (status === 'Deleted') { conditions.push("p.status = 'Deleted'"); }
    else if (status && VALID_STATUSES.includes(status)) { conditions.push('p.status = ?'); args.push(status); }
    else { conditions.push("p.status <> 'Deleted'"); }
    if (sku_code) {
      conditions.push(`EXISTS (
        SELECT 1 FROM marketplace_po_lines l
        JOIN product_vendor_codes pvc ON pvc.vendor = p.vendor AND pvc.vendor_item_code = l.item_code
        JOIN products pr ON pr.id = pvc.product_id
        WHERE l.po_id = p.po_id AND pr.sku_code LIKE ?
      )`);
      args.push(`%${sku_code}%`);
    }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const orderBy = buildOrderBy(req.query, PO_SORT_COLUMNS);
    const pag = buildPagination(req.query);

    const baseSelect = `
      SELECT p.po_id, p.vendor, p.vendor_po_id, p.po_date, p.expected_delivery_date,
             p.po_expiry_date, p.pickup_date, ${EFFECTIVE_EXPIRY_SQL} AS expiry_or_pickup,
             p.city, p.status, p.onboarded_by, p.updated_by, p.created_at, p.updated_at,
             u.name  AS created_by_name,
             ob.name AS onboarded_by_name,
             ub.name AS updated_by_name,
             (SELECT COUNT(*)            FROM marketplace_po_lines WHERE po_id = p.po_id) AS line_count,
             (SELECT COALESCE(SUM(qty),0) FROM marketplace_po_lines WHERE po_id = p.po_id) AS total_qty
      FROM marketplace_pos p
      LEFT JOIN users u  ON u.id  = p.created_by
      LEFT JOIN users ob ON ob.id = p.onboarded_by
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

async function getOne(req, res, next) {
  try {
    const { poId } = req.params;
    const { rows } = await db.execute({
      sql: `SELECT p.*, u.name AS created_by_name, ob.name AS onboarded_by_name, ub.name AS updated_by_name
            FROM marketplace_pos p
            LEFT JOIN users u  ON u.id  = p.created_by
            LEFT JOIN users ob ON ob.id = p.onboarded_by
            LEFT JOIN users ub ON ub.id = p.updated_by
            WHERE p.po_id = ?`,
      args: [poId],
    });
    if (!rows.length) return res.status(404).json({ message: 'PO not found' });
    const po = rows[0];
    const { rows: lines } = await db.execute({
      sql: `SELECT l.id, l.line_no, l.item_code, l.item_desc, l.qty,
                   pr.id AS internal_product_id, pr.sku_code AS internal_sku_code
            FROM marketplace_po_lines l
            LEFT JOIN product_vendor_codes pvc
              ON pvc.vendor = ? AND pvc.vendor_item_code = l.item_code
            LEFT JOIN products pr ON pr.id = pvc.product_id
            WHERE l.po_id = ?
            ORDER BY l.line_no`,
      args: [po.vendor, poId],
    });
    res.json({ ...po, lines });
  } catch (err) { next(err); }
}

function validatePayload(body) {
  const { vendor, vendor_po_id, po_date, po_expiry_date, pickup_date, lines } = body;
  if (!vendor || !String(vendor).trim()) return 'Invalid vendor';
  if (!vendor_po_id || !String(vendor_po_id).trim()) return 'vendor_po_id is required';
  if (!Array.isArray(lines) || lines.length === 0) return 'At least one line item is required';
  for (const ln of lines) {
    if (!ln.item_code || !String(ln.item_code).trim()) return 'Each line needs item_code';
    if (!Number.isFinite(Number(ln.qty)) || Number(ln.qty) <= 0) return 'Each line needs a positive qty';
  }
  for (const d of [po_date, po_expiry_date, pickup_date]) {
    if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return `Invalid date format: ${d}`;
  }
  return null;
}

async function create(req, res, next) {
  try {
    const err = validatePayload(req.body);
    if (err) return res.status(400).json({ message: err });
    const { vendor, vendor_po_id, po_date, po_expiry_date, city, lines, party_name } = req.body;
    const cleanPartyName = party_name == null ? null : (String(party_name).trim() || null);

    // Amazon/Flipkart carry a pickup date instead of an expiry date, and it is
    // mandatory at onboarding. Other vendors keep pickup_date null.
    const pickup_date = req.body.pickup_date ? String(req.body.pickup_date).trim() : null;
    if (PICKUP_DATE_VENDORS.includes(vendor) && !pickup_date) {
      return res.status(400).json({ message: `Pickup date is required for ${vendor} POs` });
    }

    // Appointment date is set at onboarding for Minutes POs (which never reach the
    // dispatched state where it's otherwise editable). Optional and nullable.
    let appointment_date = null;
    if (req.body.appointment_date != null && String(req.body.appointment_date).trim() !== '') {
      appointment_date = String(req.body.appointment_date).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(appointment_date)) {
        return res.status(400).json({ message: 'Invalid appointment_date format (expected YYYY-MM-DD)' });
      }
    }

    const v = await lookupActiveVendor(vendor);
    if (!v || !v.is_active) {
      return res.status(400).json({ message: 'Unknown vendor. Add it under Configurations first.' });
    }

    const cleanVendorPoId = String(vendor_po_id).trim();

    const tx = await db.transaction('write');
    try {
      const { rows: existing } = await tx.execute({
        sql: 'SELECT po_id FROM marketplace_pos WHERE vendor = ? AND vendor_po_id = ?',
        args: [vendor, cleanVendorPoId],
      });

      let poId;
      let isNew = false;
      if (existing.length) {
        poId = existing[0].po_id;
        await tx.execute({
          sql: `UPDATE marketplace_pos
                SET po_date = ?, po_expiry_date = ?, pickup_date = ?, city = ?, party_name = ?,
                    appointment_date = COALESCE(?, appointment_date),
                    status = CASE WHEN status = 'Deleted' THEN 'Open' ELSE status END,
                    updated_by = ?, updated_at = datetime('now')
                WHERE po_id = ?`,
          args: [po_date || null, po_expiry_date || null, pickup_date, city || null, cleanPartyName, appointment_date, req.user.id, poId],
        });
      } else {
        isNew = true;
        const { rows: maxRows } = await tx.execute({
          sql: `SELECT MAX(CAST(SUBSTR(po_id, 2) AS INTEGER)) AS max_seq
                FROM marketplace_pos WHERE vendor = ?`,
          args: [vendor],
        });
        const nextSeq = (Number(maxRows[0]?.max_seq) || 0) + 1;
        poId = `${vendorPrefix(vendor)}${pad3(nextSeq)}`;
        await tx.execute({
          sql: `INSERT INTO marketplace_pos
                (po_id, vendor, vendor_po_id, po_date, po_expiry_date, pickup_date, city, party_name, appointment_date, status, created_by, onboarded_by, updated_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Open', ?, ?, ?)`,
          args: [poId, vendor, cleanVendorPoId, po_date || null, po_expiry_date || null, pickup_date, city || null, cleanPartyName, appointment_date, req.user.id, req.user.id, req.user.id],
        });
      }

      await tx.execute({ sql: 'DELETE FROM marketplace_po_lines WHERE po_id = ?', args: [poId] });
      for (let idx = 0; idx < lines.length; idx++) {
        const ln = lines[idx];
        await tx.execute({
          sql: `INSERT INTO marketplace_po_lines (po_id, line_no, item_code, item_desc, qty)
                VALUES (?, ?, ?, ?, ?)`,
          args: [poId, Number(ln.line_no) || idx + 1, String(ln.item_code).trim(), ln.item_desc || null, Math.trunc(Number(ln.qty))],
        });
      }

      await logAction({
        client: tx,
        userId: req.user.id,
        actionType: isNew ? 'MARKETPLACE_PO_CREATE' : 'MARKETPLACE_PO_UPSERT',
        description: `${isNew ? 'Created' : 'Upserted'} ${vendor} PO ${poId} (vendor_po_id=${cleanVendorPoId}, ${lines.length} lines)`,
        entityType: 'marketplace_po',
        entityRef: poId,
      });

      await tx.commit();
      res.status(isNew ? 201 : 200).json({ po_id: poId, isNew });
    } catch (e) {
      await tx.rollback();
      throw e;
    }
  } catch (err) { next(err); }
}

async function update(req, res, next) {
  try {
    const { poId } = req.params;
    const { rows: existing } = await db.execute({
      sql: 'SELECT vendor, vendor_po_id, po_date, po_expiry_date, pickup_date, city FROM marketplace_pos WHERE po_id = ?',
      args: [poId],
    });
    if (!existing.length) return res.status(404).json({ message: 'PO not found' });

    // pickup_date is only editable for pickup-date vendors; for others it stays
    // null. When the field is present in the request use it (allowing null-out
    // for the wrong vendor); otherwise preserve the existing value.
    const nextPickupDate = 'pickup_date' in req.body
      ? (req.body.pickup_date ? String(req.body.pickup_date).trim() : null)
      : existing[0].pickup_date;

    const body = {
      vendor: existing[0].vendor,
      vendor_po_id: req.body.vendor_po_id || existing[0].vendor_po_id,
      po_date: req.body.po_date,
      po_expiry_date: req.body.po_expiry_date,
      pickup_date: nextPickupDate,
      city: req.body.city,
      lines: req.body.lines,
    };
    const err = validatePayload(body);
    if (err) return res.status(400).json({ message: err });
    if (PICKUP_DATE_VENDORS.includes(existing[0].vendor) && !nextPickupDate) {
      return res.status(400).json({ message: `Pickup date is required for ${existing[0].vendor} POs` });
    }

    // vendor_po_id is now editable; guard the UNIQUE(vendor, vendor_po_id)
    // constraint with a friendly message instead of a raw 500.
    const cleanVendorPoId = String(body.vendor_po_id).trim();
    if (cleanVendorPoId !== existing[0].vendor_po_id) {
      const { rows: dup } = await db.execute({
        sql: 'SELECT po_id FROM marketplace_pos WHERE vendor = ? AND vendor_po_id = ? AND po_id != ?',
        args: [existing[0].vendor, cleanVendorPoId, poId],
      });
      if (dup.length) {
        return res.status(409).json({ message: `Vendor PO No. "${cleanVendorPoId}" is already used on PO ${dup[0].po_id}` });
      }
    }

    let newOnboardedBy = null;
    const canReassign = (req.user.roles || []).some(r => ['Admin', 'Owner'].includes(r));
    if (canReassign && req.body.onboarded_by != null) {
      const onbId = Number(req.body.onboarded_by);
      if (!Number.isInteger(onbId)) return res.status(400).json({ message: 'Invalid onboarded_by' });
      const { rows: u } = await db.execute({
        sql: 'SELECT id FROM users WHERE id = ?',
        args: [onbId],
      });
      if (!u.length) return res.status(400).json({ message: 'Onboarder user not found' });
      newOnboardedBy = onbId;
    }

    const tx = await db.transaction('write');
    try {
      await tx.execute({
        sql: `UPDATE marketplace_pos
              SET vendor_po_id = ?, po_date = ?, po_expiry_date = ?, pickup_date = ?, city = ?,
                  updated_by = ?, updated_at = datetime('now')
              WHERE po_id = ?`,
        args: [
          String(body.vendor_po_id).trim(),
          body.po_date || null,
          body.po_expiry_date || null,
          body.pickup_date || null,
          body.city || null,
          req.user.id,
          poId,
        ],
      });
      if (newOnboardedBy !== null) {
        await tx.execute({
          sql: 'UPDATE marketplace_pos SET onboarded_by = ? WHERE po_id = ?',
          args: [newOnboardedBy, poId],
        });
      }
      await tx.execute({ sql: 'DELETE FROM marketplace_po_lines WHERE po_id = ?', args: [poId] });
      for (let idx = 0; idx < body.lines.length; idx++) {
        const ln = body.lines[idx];
        await tx.execute({
          sql: `INSERT INTO marketplace_po_lines (po_id, line_no, item_code, item_desc, qty)
                VALUES (?, ?, ?, ?, ?)`,
          args: [poId, Number(ln.line_no) || idx + 1, String(ln.item_code).trim(), ln.item_desc || null, Math.trunc(Number(ln.qty))],
        });
      }
      const changes = diffFields(existing[0], body, ['vendor_po_id', 'po_date', 'po_expiry_date', 'pickup_date', 'city']);
      await logAction({
        client: tx,
        userId: req.user.id,
        actionType: 'MARKETPLACE_PO_UPDATE',
        description: `Updated PO ${poId} (${body.lines.length} lines)`,
        entityType: 'marketplace_po',
        entityRef: poId,
        changes,
      });
      await tx.commit();
      res.json({ po_id: poId });
    } catch (e) {
      await tx.rollback();
      throw e;
    }
  } catch (err) { next(err); }
}

async function remove(req, res, next) {
  try {
    const { poId } = req.params;
    const { rowsAffected } = await db.execute({
      sql: `UPDATE marketplace_pos
            SET status = 'Deleted', updated_by = ?, updated_at = datetime('now')
            WHERE po_id = ? AND status <> 'Deleted'`,
      args: [req.user.id, poId],
    });
    if (!rowsAffected) return res.status(404).json({ message: 'PO not found' });
    await logAction({
      userId: req.user.id,
      actionType: 'MARKETPLACE_PO_DELETE',
      description: `Soft-deleted PO ${poId}`,
      entityType: 'marketplace_po',
      entityRef: poId,
    });
    res.json({ po_id: poId, deleted: true });
  } catch (err) { next(err); }
}

async function restore(req, res, next) {
  try {
    const { poId } = req.params;
    const { rowsAffected } = await db.execute({
      sql: `UPDATE marketplace_pos
            SET status = 'Open', updated_by = ?, updated_at = datetime('now')
            WHERE po_id = ? AND status = 'Deleted'`,
      args: [req.user.id, poId],
    });
    if (!rowsAffected) return res.status(404).json({ message: 'Deleted PO not found' });
    await logAction({
      userId: req.user.id,
      actionType: 'MARKETPLACE_PO_RESTORE',
      description: `Restored PO ${poId}`,
      entityType: 'marketplace_po',
      entityRef: poId,
    });
    res.json({ po_id: poId, restored: true });
  } catch (err) { next(err); }
}

// Per-vendor PO counts split by status (Open / Closed / Deleted) for the
// Dashboard matrix. Unlike the Order Summary counts this includes Deleted, so it
// lives here rather than in orderSummary.controller.
async function statusCountsByVendor(req, res, next) {
  try {
    const { rows } = await db.execute(
      `SELECT vendor, status, COUNT(*) AS n
       FROM marketplace_pos
       GROUP BY vendor, status`
    );
    const byVendor = new Map();
    const totals = { open: 0, closed: 0, deleted: 0 };
    const bucket = (status) =>
      status === 'Open' ? 'open' : status === 'Closed' ? 'closed' : status === 'Deleted' ? 'deleted' : null;
    for (const r of rows) {
      const key = bucket(r.status);
      if (!key) continue;
      if (!byVendor.has(r.vendor)) byVendor.set(r.vendor, { vendor: r.vendor, open: 0, closed: 0, deleted: 0 });
      const n = Number(r.n) || 0;
      byVendor.get(r.vendor)[key] += n;
      totals[key] += n;
    }
    res.json({ rows: Array.from(byVendor.values()), totals });
  } catch (err) { next(err); }
}

module.exports = { parsePreview, list, getOne, create, update, remove, restore, statusCountsByVendor, buildPagination, buildOrderBy };
