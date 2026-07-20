const db = require('../config/db');
const { logAction, diffFields } = require('../services/auditLog.service');

const VALID_STATUSES = ['Open', 'Partially Received', 'Closed'];

const padOrderNo = (id) => String(id).padStart(3, '0');

const SORT_COLUMNS = {
  id:              'p.id',
  vendor_name:     'v.name',
  company_name:    'c.name',
  status:          'p.status',
  po_date:         'p.po_date',
  updated_at:      'p.updated_at',
  updated_by_name: 'ub.name',
  line_count:      '(SELECT COUNT(*) FROM outbound_po_lines WHERE po_id = p.id)',
  total_qty:       '(SELECT COALESCE(SUM(qty),0) FROM outbound_po_lines WHERE po_id = p.id)',
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

// Status is derived from line progress, never set directly:
// every line fully accounted for (received + short >= qty) closes the PO,
// any partial progress marks it Partially Received.
function deriveStatus(lines) {
  if (!lines.length) return 'Open';
  const done = lines.every(l => Number(l.received) + Number(l.short) >= Number(l.qty));
  if (done) return 'Closed';
  const started = lines.some(l => Number(l.received) > 0 || Number(l.short) > 0);
  return started ? 'Partially Received' : 'Open';
}

// Validate raw line payloads. `mappingSet` (lowercased "cat|item|variant" keys)
// gates which article tuples are allowed; `grandfathered` tuples bypass the
// gate so vendor-config edits can never lock an existing PO's lines.
function validateLines(lines, mappingSet, grandfathered = new Set()) {
  if (!Array.isArray(lines) || !lines.length) return 'At least one line item is required';
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] || {};
    const category = String(l.category || '').trim();
    const itemName = String(l.item_name || '').trim();
    if (!category || !itemName) return `Line ${i + 1}: category and item_name are required`;
    const qty = Number(l.qty);
    if (!Number.isInteger(qty) || qty < 1) return `Line ${i + 1}: qty must be a whole number >= 1`;
    const rate = Number(l.rate);
    if (!Number.isFinite(rate) || rate < 0) return `Line ${i + 1}: rate must be a number >= 0`;
    const received = Number(l.received ?? 0);
    const short = Number(l.short ?? 0);
    if (!Number.isInteger(received) || received < 0) return `Line ${i + 1}: received must be a whole number >= 0`;
    if (!Number.isInteger(short) || short < 0) return `Line ${i + 1}: short must be a whole number >= 0`;
    const key = lineKey(l);
    if (!mappingSet.has(key) && !grandfathered.has(key)) {
      return `Line ${i + 1}: "${category} - ${itemName}${l.variant ? ` - ${l.variant}` : ''}" is not in the vendor's article mappings`;
    }
  }
  return null;
}

function lineKey(l) {
  return `${String(l.category || '').trim().toLowerCase()}${String(l.item_name || '').trim().toLowerCase()}${String(l.variant || '').trim().toLowerCase()}`;
}

function normLine(l, idx) {
  return {
    line_no: Number(l.line_no) || idx + 1,
    category: String(l.category).trim(),
    item_name: String(l.item_name).trim(),
    variant: String(l.variant || '').trim() || null,
    qty: Math.trunc(Number(l.qty)),
    rate: Number(l.rate) || 0,
    received: Math.trunc(Number(l.received ?? 0)),
    short: Math.trunc(Number(l.short ?? 0)),
  };
}

// Validates an optional user-reference field (e.g. approved_by): '' / null
// clears it, an id must resolve to a real user. Returns [value, errorMessage].
async function resolveUserRef(id, label) {
  if (id == null || id === '') return [null, null];
  const { rows } = await db.execute({ sql: 'SELECT id FROM users WHERE id = ?', args: [id] });
  if (!rows.length) return [null, `${label}: user not found`];
  return [id, null];
}

async function vendorMappingSet(vendorId) {
  const { rows } = await db.execute({
    sql: 'SELECT category, item_name, variant FROM outbound_vendor_articles WHERE vendor_id = ?',
    args: [vendorId],
  });
  return new Set(rows.map(lineKey));
}

async function fetchLines(poIds) {
  if (!poIds.length) return new Map();
  const placeholders = poIds.map(() => '?').join(',');
  const { rows } = await db.execute({
    sql: `SELECT id, po_id, line_no, category, item_name, variant, qty, rate, received, short
          FROM outbound_po_lines WHERE po_id IN (${placeholders}) ORDER BY po_id, line_no`,
    args: poIds,
  });
  const byPo = new Map();
  for (const l of rows) {
    if (!byPo.has(l.po_id)) byPo.set(l.po_id, []);
    byPo.get(l.po_id).push(l);
  }
  return byPo;
}

const BASE_SELECT = `
  SELECT p.id, p.vendor_id, p.company_id, p.po_date, p.status, p.approved_by,
         p.created_at, p.updated_at,
         v.name AS vendor_name,
         c.name AS company_name,
         ab.name AS approved_by_name,
         cb.name AS created_by_name,
         COALESCE(ub.name, cb.name) AS updated_by_name
  FROM outbound_pos p
  JOIN outbound_vendors v ON v.id = p.vendor_id
  LEFT JOIN companies c ON c.id = p.company_id
  LEFT JOIN users ab ON ab.id = p.approved_by
  LEFT JOIN users cb ON cb.id = p.created_by
  LEFT JOIN users ub ON ub.id = p.updated_by
`;

function withOrderNo(row) {
  return { ...row, order_no: padOrderNo(row.id) };
}

async function list(req, res, next) {
  try {
    const { order_no, vendor_id, status, po_date_from, po_date_to } = req.query;
    const conditions = [];
    const args = [];
    if (order_no) {
      const n = parseInt(String(order_no).replace(/^0+/, ''), 10);
      if (Number.isInteger(n)) { conditions.push('p.id = ?'); args.push(n); }
      else { conditions.push('0'); }
    }
    if (vendor_id) { conditions.push('p.vendor_id = ?'); args.push(vendor_id); }
    if (po_date_from) { conditions.push('p.po_date >= ?'); args.push(po_date_from); }
    if (po_date_to)   { conditions.push('p.po_date <= ?'); args.push(po_date_to); }
    if (status === 'Deleted') { conditions.push("p.status = 'Deleted'"); }
    else if (status && VALID_STATUSES.includes(status)) { conditions.push('p.status = ?'); args.push(status); }
    else { conditions.push("p.status <> 'Deleted'"); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const orderBy = buildOrderBy(req.query, SORT_COLUMNS);
    const pag = buildPagination(req.query);
    const baseSelect = `${BASE_SELECT} ${where} ORDER BY ${orderBy}`;

    let rows, total, page, page_size;
    if (!pag.paginated) {
      ({ rows } = await db.execute({ sql: baseSelect, args }));
      total = rows.length; page = 1; page_size = rows.length;
    } else {
      const [{ rows: pageRows }, { rows: countRows }] = await Promise.all([
        db.execute({ sql: `${baseSelect} LIMIT ? OFFSET ?`, args: [...args, pag.page_size, pag.offset] }),
        db.execute({ sql: `SELECT COUNT(*) AS total FROM outbound_pos p ${where}`, args }),
      ]);
      rows = pageRows;
      total = Number(countRows[0]?.total) || 0;
      page = pag.page; page_size = pag.page_size;
    }

    const linesByPo = await fetchLines(rows.map(r => r.id));
    res.json({
      rows: rows.map(r => ({ ...withOrderNo(r), lines: linesByPo.get(r.id) || [] })),
      total, page, page_size,
    });
  } catch (err) { next(err); }
}

async function getOne(req, res, next) {
  try {
    const { id } = req.params;
    const { rows } = await db.execute({ sql: `${BASE_SELECT} WHERE p.id = ?`, args: [id] });
    if (!rows.length) return res.status(404).json({ message: 'PO not found' });
    const linesByPo = await fetchLines([rows[0].id]);
    res.json({ ...withOrderNo(rows[0]), lines: linesByPo.get(rows[0].id) || [] });
  } catch (err) { next(err); }
}

async function create(req, res, next) {
  try {
    const { vendor_id, company_id, po_date, approved_by, lines } = req.body || {};

    const { rows: vendor } = await db.execute({
      sql: 'SELECT id, name, is_active FROM outbound_vendors WHERE id = ?',
      args: [vendor_id],
    });
    if (!vendor.length) return res.status(400).json({ message: 'Vendor not found' });
    if (!vendor[0].is_active) return res.status(400).json({ message: `Vendor "${vendor[0].name}" is inactive` });

    if (company_id != null && company_id !== '') {
      const { rows: company } = await db.execute({
        sql: 'SELECT id, is_active FROM companies WHERE id = ?',
        args: [company_id],
      });
      if (!company.length) return res.status(400).json({ message: 'Company not found' });
      if (!company[0].is_active) return res.status(400).json({ message: 'Company is inactive' });
    }

    const [approvedById, approvedByErr] = await resolveUserRef(approved_by, 'Approved By');
    if (approvedByErr) return res.status(400).json({ message: approvedByErr });

    const mappingSet = await vendorMappingSet(vendor_id);
    const linesError = validateLines(lines, mappingSet);
    if (linesError) return res.status(400).json({ message: linesError });
    const normLines = lines.map(normLine);
    const status = deriveStatus(normLines);

    const tx = await db.transaction('write');
    try {
      const { rows: created } = await tx.execute({
        sql: `INSERT INTO outbound_pos (vendor_id, company_id, po_date, status, approved_by, created_by, updated_by)
              VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        args: [vendor_id, company_id || null, po_date || null, status, approvedById, req.user.id, req.user.id],
      });
      const poId = created[0].id;
      for (const l of normLines) {
        await tx.execute({
          sql: `INSERT INTO outbound_po_lines (po_id, line_no, category, item_name, variant, qty, rate, received, short)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [poId, l.line_no, l.category, l.item_name, l.variant, l.qty, l.rate, l.received, l.short],
        });
      }
      await logAction({
        client: tx,
        userId: req.user.id,
        actionType: 'OUTBOUND_PO_CREATE',
        description: `Created outbound PO ${padOrderNo(poId)} for "${vendor[0].name}" (${normLines.length} lines)`,
        entityType: 'outbound_po',
        entityId: poId,
        entityRef: padOrderNo(poId),
      });
      await tx.commit();
      res.status(201).json({ id: poId, order_no: padOrderNo(poId), status });
    } catch (e) {
      await tx.rollback();
      throw e;
    }
  } catch (err) { next(err); }
}

async function update(req, res, next) {
  try {
    const { id } = req.params;
    const has = (k) => Object.prototype.hasOwnProperty.call(req.body || {}, k);

    const { rows: existing } = await db.execute({
      sql: 'SELECT id, vendor_id, company_id, po_date, status, approved_by FROM outbound_pos WHERE id = ?',
      args: [id],
    });
    if (!existing.length) return res.status(404).json({ message: 'PO not found' });
    const current = existing[0];
    if (current.status === 'Deleted') return res.status(400).json({ message: 'PO is deleted; restore it first' });

    let nextCompanyId = current.company_id;
    if (has('company_id')) {
      nextCompanyId = req.body.company_id || null;
      if (nextCompanyId != null) {
        const { rows: company } = await db.execute({
          sql: 'SELECT id, is_active FROM companies WHERE id = ?',
          args: [nextCompanyId],
        });
        if (!company.length) return res.status(400).json({ message: 'Company not found' });
      }
    }
    const nextPoDate = has('po_date') ? (req.body.po_date || null) : current.po_date;

    let nextApprovedBy = current.approved_by;
    if (has('approved_by')) {
      const [approvedById, approvedByErr] = await resolveUserRef(req.body.approved_by, 'Approved By');
      if (approvedByErr) return res.status(400).json({ message: approvedByErr });
      nextApprovedBy = approvedById;
    }
    // Optional at creation, but every subsequent edit must carry an approver —
    // covers a PO created without one and every edit after that.
    if (nextApprovedBy == null) {
      return res.status(400).json({ message: 'Approved By is required to save changes to this PO' });
    }

    let nextLines = null;
    let nextStatus = current.status;
    if (has('lines')) {
      const mappingSet = await vendorMappingSet(current.vendor_id);
      const { rows: existingLines } = await db.execute({
        sql: 'SELECT category, item_name, variant FROM outbound_po_lines WHERE po_id = ?',
        args: [id],
      });
      const grandfathered = new Set(existingLines.map(lineKey));
      const linesError = validateLines(req.body.lines, mappingSet, grandfathered);
      if (linesError) return res.status(400).json({ message: linesError });
      nextLines = req.body.lines.map(normLine);
      nextStatus = deriveStatus(nextLines);
    }

    const changes = diffFields(
      current,
      { company_id: nextCompanyId, po_date: nextPoDate, status: nextStatus, approved_by: nextApprovedBy },
      ['company_id', 'po_date', 'status', 'approved_by'],
    );

    const tx = await db.transaction('write');
    try {
      await tx.execute({
        sql: `UPDATE outbound_pos SET company_id = ?, po_date = ?, status = ?, approved_by = ?,
                updated_by = ?, updated_at = datetime('now')
              WHERE id = ?`,
        args: [nextCompanyId, nextPoDate, nextStatus, nextApprovedBy, req.user.id, id],
      });
      if (nextLines) {
        await tx.execute({ sql: 'DELETE FROM outbound_po_lines WHERE po_id = ?', args: [id] });
        for (const l of nextLines) {
          await tx.execute({
            sql: `INSERT INTO outbound_po_lines (po_id, line_no, category, item_name, variant, qty, rate, received, short)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [id, l.line_no, l.category, l.item_name, l.variant, l.qty, l.rate, l.received, l.short],
          });
        }
      }
      await logAction({
        client: tx,
        userId: req.user.id,
        actionType: 'OUTBOUND_PO_UPDATE',
        description: `Updated outbound PO ${padOrderNo(id)}${nextLines ? ` (${nextLines.length} lines)` : ''}, status=${nextStatus}`,
        entityType: 'outbound_po',
        entityId: id,
        entityRef: padOrderNo(id),
        changes,
      });
      await tx.commit();
    } catch (e) {
      await tx.rollback();
      throw e;
    }

    const { rows } = await db.execute({ sql: `${BASE_SELECT} WHERE p.id = ?`, args: [id] });
    const linesByPo = await fetchLines([Number(id)]);
    res.json({ ...withOrderNo(rows[0]), lines: linesByPo.get(Number(id)) || [] });
  } catch (err) { next(err); }
}

async function remove(req, res, next) {
  try {
    const { id } = req.params;
    const { rows: existing } = await db.execute({
      sql: 'SELECT id, status FROM outbound_pos WHERE id = ?',
      args: [id],
    });
    if (!existing.length) return res.status(404).json({ message: 'PO not found' });
    if (existing[0].status === 'Deleted') return res.status(400).json({ message: 'PO is already deleted' });

    await db.execute({
      sql: `UPDATE outbound_pos SET status = 'Deleted', updated_by = ?, updated_at = datetime('now') WHERE id = ?`,
      args: [req.user.id, id],
    });
    await logAction({
      userId: req.user.id,
      actionType: 'OUTBOUND_PO_DELETE',
      description: `Deleted outbound PO ${padOrderNo(id)}`,
      entityType: 'outbound_po',
      entityId: id,
      entityRef: padOrderNo(id),
    });
    res.json({ id: Number(id), status: 'Deleted' });
  } catch (err) { next(err); }
}

async function restore(req, res, next) {
  try {
    const { id } = req.params;
    const { rows: existing } = await db.execute({
      sql: 'SELECT id, status FROM outbound_pos WHERE id = ?',
      args: [id],
    });
    if (!existing.length) return res.status(404).json({ message: 'PO not found' });
    if (existing[0].status !== 'Deleted') return res.status(400).json({ message: 'PO is not deleted' });

    const linesByPo = await fetchLines([Number(id)]);
    const status = deriveStatus(linesByPo.get(Number(id)) || []);
    await db.execute({
      sql: `UPDATE outbound_pos SET status = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?`,
      args: [status, req.user.id, id],
    });
    await logAction({
      userId: req.user.id,
      actionType: 'OUTBOUND_PO_RESTORE',
      description: `Restored outbound PO ${padOrderNo(id)} (status=${status})`,
      entityType: 'outbound_po',
      entityId: id,
      entityRef: padOrderNo(id),
    });
    res.json({ id: Number(id), status });
  } catch (err) { next(err); }
}

module.exports = { list, getOne, create, update, remove, restore };
