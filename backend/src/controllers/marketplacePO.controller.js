const db = require('../config/db');
const { logAction } = require('../services/auditLog.service');
const { parse } = require('../parsers/marketplacePO');

const VENDOR_PREFIX = { Swiggy: 'S', Zepto: 'Z', Blinkit: 'B' };
const VALID_VENDORS = Object.keys(VENDOR_PREFIX);
const VALID_STATUSES = ['Open', 'In Progress', 'Completed', 'Cancelled'];

function pad3(n) { return String(n).padStart(3, '0'); }

async function parsePreview(req, res, next) {
  try {
    const { vendor } = req.body;
    if (!VALID_VENDORS.includes(vendor)) {
      return res.status(400).json({ message: 'Invalid vendor. Must be Swiggy, Zepto, or Blinkit.' });
    }
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ message: 'PDF file is required' });
    }

    let parsed;
    try {
      parsed = await parse(vendor, req.file.buffer);
    } catch (err) {
      return res.status(400).json({ message: `Parse failed: ${err.message}` });
    }

    await logAction({
      userId: req.user.id,
      actionType: 'MARKETPLACE_PO_PARSE',
      description: `Parsed ${vendor} PO ${parsed.vendor_po_id} (${parsed.lines.length} lines)`,
      entityType: 'marketplace_po',
    });

    res.json({ vendor, ...parsed });
  } catch (err) { next(err); }
}

async function list(req, res, next) {
  try {
    const { vendor, search } = req.query;
    const conditions = [];
    const args = [];
    if (vendor && VALID_VENDORS.includes(vendor)) {
      conditions.push('p.vendor = ?');
      args.push(vendor);
    }
    if (search) {
      conditions.push('(p.po_id LIKE ? OR p.vendor_po_id LIKE ?)');
      args.push(`%${search}%`, `%${search}%`);
    }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const { rows } = await db.execute({
      sql: `
        SELECT p.po_id, p.vendor, p.vendor_po_id, p.po_date, p.expected_delivery_date,
               p.po_expiry_date, p.city, p.status, p.onboarded_by, p.updated_by, p.created_at, p.updated_at,
               u.name AS created_by_name,
               ob.name AS onboarded_by_name,
               ub.name AS updated_by_name,
               (SELECT COUNT(*) FROM marketplace_po_lines WHERE po_id = p.po_id) AS line_count
        FROM marketplace_pos p
        LEFT JOIN users u  ON u.id  = p.created_by
        LEFT JOIN users ob ON ob.id = p.onboarded_by
        LEFT JOIN users ub ON ub.id = p.updated_by
        ${where}
        ORDER BY p.updated_at DESC
      `,
      args,
    });
    res.json(rows);
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
      sql: `SELECT id, line_no, item_code, item_desc, qty
            FROM marketplace_po_lines WHERE po_id = ? ORDER BY line_no`,
      args: [poId],
    });
    res.json({ ...po, lines });
  } catch (err) { next(err); }
}

function validatePayload(body) {
  const { vendor, vendor_po_id, po_date, expected_delivery_date, po_expiry_date, lines } = body;
  if (!VALID_VENDORS.includes(vendor)) return 'Invalid vendor';
  if (!vendor_po_id || !String(vendor_po_id).trim()) return 'vendor_po_id is required';
  if (!Array.isArray(lines) || lines.length === 0) return 'At least one line item is required';
  for (const ln of lines) {
    if (!ln.item_code || !String(ln.item_code).trim()) return 'Each line needs item_code';
    if (!Number.isFinite(Number(ln.qty)) || Number(ln.qty) <= 0) return 'Each line needs a positive qty';
  }
  for (const d of [po_date, expected_delivery_date, po_expiry_date]) {
    if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return `Invalid date format: ${d}`;
  }
  return null;
}

async function create(req, res, next) {
  try {
    const err = validatePayload(req.body);
    if (err) return res.status(400).json({ message: err });
    const { vendor, vendor_po_id, po_date, expected_delivery_date, po_expiry_date, city, lines } = req.body;
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
                SET po_date = ?, expected_delivery_date = ?, po_expiry_date = ?, city = ?,
                    updated_by = ?, updated_at = datetime('now')
                WHERE po_id = ?`,
          args: [po_date || null, expected_delivery_date || null, po_expiry_date || null, city || null, req.user.id, poId],
        });
      } else {
        isNew = true;
        const { rows: maxRows } = await tx.execute({
          sql: `SELECT MAX(CAST(SUBSTR(po_id, 2) AS INTEGER)) AS max_seq
                FROM marketplace_pos WHERE vendor = ?`,
          args: [vendor],
        });
        const nextSeq = (Number(maxRows[0]?.max_seq) || 0) + 1;
        poId = `${VENDOR_PREFIX[vendor]}${pad3(nextSeq)}`;
        await tx.execute({
          sql: `INSERT INTO marketplace_pos
                (po_id, vendor, vendor_po_id, po_date, expected_delivery_date, po_expiry_date, city, created_by, onboarded_by, updated_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [poId, vendor, cleanVendorPoId, po_date || null, expected_delivery_date || null, po_expiry_date || null, city || null, req.user.id, req.user.id, req.user.id],
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
      sql: 'SELECT vendor, vendor_po_id FROM marketplace_pos WHERE po_id = ?',
      args: [poId],
    });
    if (!existing.length) return res.status(404).json({ message: 'PO not found' });

    const body = {
      vendor: existing[0].vendor,
      vendor_po_id: req.body.vendor_po_id || existing[0].vendor_po_id,
      po_date: req.body.po_date,
      expected_delivery_date: req.body.expected_delivery_date,
      po_expiry_date: req.body.po_expiry_date,
      city: req.body.city,
      lines: req.body.lines,
    };
    const err = validatePayload(body);
    if (err) return res.status(400).json({ message: err });

    let statusToSet = null;
    if (req.body.status != null) {
      if (!VALID_STATUSES.includes(req.body.status)) {
        return res.status(400).json({ message: 'Invalid status' });
      }
      statusToSet = req.body.status;
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
      const { rows: rr } = await db.execute({
        sql: 'SELECT role FROM user_roles WHERE user_id = ?',
        args: [onbId],
      });
      if (!rr.some(r => r.role === 'PO_Executive')) {
        return res.status(400).json({ message: 'Onboarder must be a PO_Executive' });
      }
      newOnboardedBy = onbId;
    }

    const tx = await db.transaction('write');
    try {
      await tx.execute({
        sql: `UPDATE marketplace_pos
              SET vendor_po_id = ?, po_date = ?, expected_delivery_date = ?, po_expiry_date = ?, city = ?,
                  updated_by = ?, updated_at = datetime('now')
              WHERE po_id = ?`,
        args: [
          String(body.vendor_po_id).trim(),
          body.po_date || null,
          body.expected_delivery_date || null,
          body.po_expiry_date || null,
          body.city || null,
          req.user.id,
          poId,
        ],
      });
      if (statusToSet !== null) {
        await tx.execute({
          sql: 'UPDATE marketplace_pos SET status = ? WHERE po_id = ?',
          args: [statusToSet, poId],
        });
      }
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
      await logAction({
        client: tx,
        userId: req.user.id,
        actionType: 'MARKETPLACE_PO_UPDATE',
        description: `Updated PO ${poId} (${body.lines.length} lines)`,
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

async function remove(req, res, next) {
  try {
    const { poId } = req.params;
    const { rowsAffected } = await db.execute({
      sql: 'DELETE FROM marketplace_pos WHERE po_id = ?',
      args: [poId],
    });
    if (!rowsAffected) return res.status(404).json({ message: 'PO not found' });
    await logAction({
      userId: req.user.id,
      actionType: 'MARKETPLACE_PO_DELETE',
      description: `Deleted PO ${poId}`,
      entityType: 'marketplace_po',
    });
    res.json({ po_id: poId, deleted: true });
  } catch (err) { next(err); }
}

module.exports = { parsePreview, list, getOne, create, update, remove };
