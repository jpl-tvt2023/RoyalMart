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
  approved_by_name: 'ab.name',
  approval_date:   'p.approval_date',
  updated_at:      'p.updated_at',
  updated_by_name: 'ub.name',
  line_count:      "(SELECT COUNT(*) FROM outbound_po_lines WHERE po_id = p.id AND deleted_at IS NULL)",
  total_qty:       "(SELECT COALESCE(SUM(qty),0) FROM outbound_po_lines WHERE po_id = p.id AND deleted_at IS NULL)",
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

// Per-line status, derived from qty vs. received (sum of active receipts) + short.
function computeLineStatus(line) {
  const qty = Number(line.qty);
  const received = Number(line.received) || 0;
  const short = Number(line.short) || 0;
  if (received + short >= qty) return 'Closed';
  if (received > 0 || short > 0) return 'Partially Received';
  return 'Open';
}

// PO header status rolls up from its active (non-deleted) lines' computed
// statuses: every line fully accounted for closes the PO, any partial
// progress marks it Partially Received.
function deriveStatus(lines) {
  const active = lines.filter(l => !l.deleted_at);
  if (!active.length) return 'Open';
  if (active.every(l => computeLineStatus(l) === 'Closed')) return 'Closed';
  if (active.some(l => computeLineStatus(l) !== 'Open')) return 'Partially Received';
  return 'Open';
}

// Validate raw line payloads (Order Details fields only — qty may be
// decimal). `mappingSet` (lowercased "cat|item|variant" keys) gates which
// article tuples are allowed; `grandfathered` tuples bypass the gate so
// vendor-config edits can never lock an existing PO's lines.
function validateLines(lines, mappingSet, grandfathered = new Set()) {
  if (!Array.isArray(lines) || !lines.length) return 'At least one line item is required';
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] || {};
    const category = String(l.category || '').trim();
    const itemName = String(l.item_name || '').trim();
    if (!category || !itemName) return `Line ${i + 1}: category and item_name are required`;
    const qty = Number(l.qty);
    if (!Number.isFinite(qty) || qty <= 0) return `Line ${i + 1}: qty must be a number > 0`;
    const rate = Number(l.rate);
    if (!Number.isFinite(rate) || rate < 0) return `Line ${i + 1}: rate must be a number >= 0`;
    const key = lineKey(l);
    if (!mappingSet.has(key) && !grandfathered.has(key)) {
      return `Line ${i + 1}: "${category} - ${itemName}${l.variant ? ` - ${l.variant}` : ''}" is not in the vendor's article mappings`;
    }
  }
  return null;
}

function lineKey(l) {
  return `${String(l.category || '').trim().toLowerCase()}${String(l.item_name || '').trim().toLowerCase()}${String(l.variant || '').trim().toLowerCase()}`;
}

function normLine(l, idx) {
  return {
    id: l.id ? Number(l.id) : null,
    line_no: Number(l.line_no) || idx + 1,
    category: String(l.category).trim(),
    item_name: String(l.item_name).trim(),
    variant: String(l.variant || '').trim() || null,
    qty: Number(l.qty),
    rate: Number(l.rate) || 0,
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

// Fetch lines for the given PO ids. By default excludes soft-deleted lines
// and computes `received` as the sum of active receipts via a subquery
// (cheap — used by list()). Pass withReceipts to also attach each line's
// full receipts array (used by getOne() for the detail page's Receiving
// table). Pass client to participate in an in-flight transaction.
async function fetchLines(poIds, { withReceipts = false, includeDeleted = false, client } = {}) {
  const executor = client || db;
  if (!poIds.length) return new Map();
  const placeholders = poIds.map(() => '?').join(',');
  const deletedClause = includeDeleted ? '' : 'AND l.deleted_at IS NULL';
  const { rows } = await executor.execute({
    sql: `SELECT l.id, l.po_id, l.line_no, l.category, l.item_name, l.variant, l.qty, l.rate, l.short,
                 l.updated_by, l.updated_at, l.deleted_by, l.deleted_at,
                 ub.name AS updated_by_name,
                 COALESCE((SELECT SUM(r.received_qty) FROM outbound_po_line_receipts r
                           WHERE r.line_id = l.id AND r.deleted_at IS NULL), 0) AS received
          FROM outbound_po_lines l
          LEFT JOIN users ub ON ub.id = l.updated_by
          WHERE l.po_id IN (${placeholders}) ${deletedClause}
          ORDER BY l.po_id, l.line_no`,
    args: poIds,
  });

  if (withReceipts && rows.length) {
    const lineIds = rows.map(r => r.id);
    const rPlaceholders = lineIds.map(() => '?').join(',');
    const receiptDeletedClause = includeDeleted ? '' : 'AND r.deleted_at IS NULL';
    const { rows: receipts } = await executor.execute({
      sql: `SELECT r.id, r.line_id, r.received_qty, r.received_rate, r.bill_no,
                   r.created_by, r.created_at, r.updated_by, r.updated_at, r.deleted_by, r.deleted_at,
                   cb.name AS created_by_name, ub.name AS updated_by_name
            FROM outbound_po_line_receipts r
            LEFT JOIN users cb ON cb.id = r.created_by
            LEFT JOIN users ub ON ub.id = r.updated_by
            WHERE r.line_id IN (${rPlaceholders}) ${receiptDeletedClause}
            ORDER BY r.line_id, r.created_at, r.id`,
      args: lineIds,
    });
    const receiptsByLine = new Map();
    for (const r of receipts) {
      if (!receiptsByLine.has(r.line_id)) receiptsByLine.set(r.line_id, []);
      receiptsByLine.get(r.line_id).push(r);
    }
    for (const l of rows) l.receipts = receiptsByLine.get(l.id) || [];
  }

  const byPo = new Map();
  for (const l of rows) {
    if (!byPo.has(l.po_id)) byPo.set(l.po_id, []);
    byPo.get(l.po_id).push(l);
  }
  return byPo;
}

// Recompute a PO's header status from its current active lines and persist
// it if it changed, logging the transition on the PO's own audit trail (so
// its History still reflects status changes triggered by a line/receipt
// action, not just a whole-PO edit). Must run inside the caller's tx.
async function recomputeAndPersistStatus(tx, poId, userId) {
  const { rows: poRows } = await tx.execute({ sql: 'SELECT status FROM outbound_pos WHERE id = ?', args: [poId] });
  const prevStatus = poRows[0]?.status;
  const freshLines = (await fetchLines([poId], { client: tx })).get(poId) || [];
  const nextStatus = deriveStatus(freshLines);
  if (nextStatus !== prevStatus) {
    await tx.execute({
      sql: `UPDATE outbound_pos SET status = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?`,
      args: [nextStatus, userId, poId],
    });
    await logAction({
      client: tx,
      userId,
      actionType: 'OUTBOUND_PO_STATUS_UPDATE',
      description: `PO ${padOrderNo(poId)} status changed to ${nextStatus}`,
      entityType: 'outbound_po',
      entityId: poId,
      entityRef: padOrderNo(poId),
      changes: [{ field: 'status', old: prevStatus, new: nextStatus }],
    });
  }
  return nextStatus;
}

const BASE_SELECT = `
  SELECT p.id, p.vendor_id, p.company_id, p.po_date, p.status, p.approved_by, p.approval_date,
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
    if (status === 'Deleted') {
      conditions.push("p.status = 'Deleted'");
    } else if (status) {
      const values = String(status).split(',').map(s => s.trim()).filter(s => VALID_STATUSES.includes(s));
      if (values.length) {
        conditions.push(`p.status IN (${values.map(() => '?').join(',')})`);
        args.push(...values);
      } else {
        conditions.push("p.status <> 'Deleted'");
      }
    } else {
      conditions.push("p.status <> 'Deleted'");
    }
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
    const includeDeleted = req.query.include_deleted === '1' || req.query.include_deleted === 'true';
    const linesByPo = await fetchLines([rows[0].id], { withReceipts: true, includeDeleted });
    res.json({ ...withOrderNo(rows[0]), lines: linesByPo.get(rows[0].id) || [] });
  } catch (err) { next(err); }
}

async function create(req, res, next) {
  try {
    const { vendor_id, company_id, po_date, approved_by, approval_date, lines } = req.body || {};

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
    if (approvedById != null && !approval_date) {
      return res.status(400).json({ message: 'Approval Date is required when setting an approver' });
    }

    const mappingSet = await vendorMappingSet(vendor_id);
    const linesError = validateLines(lines, mappingSet);
    if (linesError) return res.status(400).json({ message: linesError });
    const normLines = lines.map(normLine);
    // Brand-new lines have no receipts yet, so every line starts at
    // received=0/short=0 for status-derivation purposes.
    const status = deriveStatus(normLines.map(l => ({ ...l, received: 0, short: 0 })));

    const tx = await db.transaction('write');
    try {
      const { rows: created } = await tx.execute({
        sql: `INSERT INTO outbound_pos (vendor_id, company_id, po_date, status, approved_by, approval_date, created_by, updated_by)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        args: [vendor_id, company_id || null, po_date || null, status, approvedById, approval_date || null, req.user.id, req.user.id],
      });
      const poId = created[0].id;
      for (const l of normLines) {
        const { rows: insertedLine } = await tx.execute({
          sql: `INSERT INTO outbound_po_lines (po_id, line_no, category, item_name, variant, qty, rate, updated_by, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now')) RETURNING id`,
          args: [poId, l.line_no, l.category, l.item_name, l.variant, l.qty, l.rate, req.user.id],
        });
        await logAction({
          client: tx,
          userId: req.user.id,
          actionType: 'OUTBOUND_PO_LINE_CREATE',
          description: `Added line "${l.category} - ${l.item_name}${l.variant ? ` - ${l.variant}` : ''}" (qty ${l.qty}) to PO ${padOrderNo(poId)}`,
          entityType: 'outbound_po_line',
          entityId: insertedLine[0].id,
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
      sql: 'SELECT id, vendor_id, company_id, po_date, status, approved_by, approval_date FROM outbound_pos WHERE id = ?',
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

    // Approval Date is only required when the approver is actually being set
    // for the first time or changed to someone else — an edit that leaves
    // the approver untouched keeps whatever approval_date is already stored.
    let nextApprovalDate = current.approval_date;
    const approverChanged = String(current.approved_by ?? '') !== String(nextApprovedBy ?? '');
    if (approverChanged) {
      const suppliedDate = has('approval_date') ? req.body.approval_date : null;
      if (!suppliedDate) {
        return res.status(400).json({ message: 'Approval Date is required when changing the approver' });
      }
      nextApprovalDate = suppliedDate;
    } else if (has('approval_date') && req.body.approval_date) {
      nextApprovalDate = req.body.approval_date;
    }

    let nextLines = null;
    let existingLines = [];
    if (has('lines')) {
      const mappingSet = await vendorMappingSet(current.vendor_id);
      const { rows: activeLines } = await db.execute({
        sql: 'SELECT id, category, item_name, variant, qty, rate FROM outbound_po_lines WHERE po_id = ? AND deleted_at IS NULL',
        args: [id],
      });
      existingLines = activeLines;
      const grandfathered = new Set(existingLines.map(lineKey));
      const linesError = validateLines(req.body.lines, mappingSet, grandfathered);
      if (linesError) return res.status(400).json({ message: linesError });
      nextLines = req.body.lines.map(normLine);
    }

    const tx = await db.transaction('write');
    try {
      if (nextLines) {
        const byId = new Map(existingLines.map(l => [l.id, l]));
        const keptIds = new Set();
        for (const l of nextLines) {
          if (l.id && byId.has(l.id)) {
            keptIds.add(l.id);
            const before = byId.get(l.id);
            const lineChanges = diffFields(before, l, ['line_no', 'category', 'item_name', 'variant', 'qty', 'rate']);
            if (lineChanges.length) {
              await tx.execute({
                sql: `UPDATE outbound_po_lines SET line_no=?, category=?, item_name=?, variant=?, qty=?, rate=?,
                        updated_by=?, updated_at=datetime('now') WHERE id=?`,
                args: [l.line_no, l.category, l.item_name, l.variant, l.qty, l.rate, req.user.id, l.id],
              });
              await logAction({
                client: tx,
                userId: req.user.id,
                actionType: 'OUTBOUND_PO_LINE_UPDATE',
                description: `Updated line "${l.category} - ${l.item_name}${l.variant ? ` - ${l.variant}` : ''}" on PO ${padOrderNo(id)}`,
                entityType: 'outbound_po_line',
                entityId: l.id,
                changes: lineChanges,
              });
            }
          } else {
            const { rows: insertedLine } = await tx.execute({
              sql: `INSERT INTO outbound_po_lines (po_id, line_no, category, item_name, variant, qty, rate, updated_by, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now')) RETURNING id`,
              args: [id, l.line_no, l.category, l.item_name, l.variant, l.qty, l.rate, req.user.id],
            });
            await logAction({
              client: tx,
              userId: req.user.id,
              actionType: 'OUTBOUND_PO_LINE_CREATE',
              description: `Added line "${l.category} - ${l.item_name}${l.variant ? ` - ${l.variant}` : ''}" (qty ${l.qty}) to PO ${padOrderNo(id)}`,
              entityType: 'outbound_po_line',
              entityId: insertedLine[0].id,
            });
          }
        }
        // Any active line not present in the submitted set was removed via
        // the line editor's trash icon — soft-delete it rather than wiping it.
        for (const before of existingLines) {
          if (!keptIds.has(before.id)) {
            await tx.execute({
              sql: `UPDATE outbound_po_lines SET deleted_by=?, deleted_at=datetime('now'), updated_by=?, updated_at=datetime('now') WHERE id=?`,
              args: [req.user.id, req.user.id, before.id],
            });
            await logAction({
              client: tx,
              userId: req.user.id,
              actionType: 'OUTBOUND_PO_LINE_DELETE',
              description: `Removed line "${before.category} - ${before.item_name}${before.variant ? ` - ${before.variant}` : ''}" from PO ${padOrderNo(id)}`,
              entityType: 'outbound_po_line',
              entityId: before.id,
            });
          }
        }
      }

      // Recompute status from a fresh read — the lines payload no longer
      // carries received/short, so status can't be derived from it directly.
      const freshLines = (await fetchLines([Number(id)], { client: tx })).get(Number(id)) || [];
      const nextStatus = deriveStatus(freshLines);

      const changes = diffFields(
        current,
        { company_id: nextCompanyId, po_date: nextPoDate, status: nextStatus, approved_by: nextApprovedBy, approval_date: nextApprovalDate },
        ['company_id', 'po_date', 'status', 'approved_by', 'approval_date'],
      );

      await tx.execute({
        sql: `UPDATE outbound_pos SET company_id = ?, po_date = ?, status = ?, approved_by = ?, approval_date = ?,
                updated_by = ?, updated_at = datetime('now')
              WHERE id = ?`,
        args: [nextCompanyId, nextPoDate, nextStatus, nextApprovedBy, nextApprovalDate, req.user.id, id],
      });
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
    const linesByPo = await fetchLines([Number(id)], { withReceipts: true });
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

// PATCH /:id/lines/:lineId — update a line's Short value only (Received is
// managed exclusively through the receipts endpoints below).
async function updateLineShort(req, res, next) {
  try {
    const { id, lineId } = req.params;
    const { rows: poRows } = await db.execute({ sql: 'SELECT id, status FROM outbound_pos WHERE id = ?', args: [id] });
    if (!poRows.length) return res.status(404).json({ message: 'PO not found' });
    if (poRows[0].status === 'Deleted') return res.status(400).json({ message: 'PO is deleted; restore it first' });

    const { rows: lineRows } = await db.execute({
      sql: 'SELECT id, category, item_name, variant, short FROM outbound_po_lines WHERE id = ? AND po_id = ? AND deleted_at IS NULL',
      args: [lineId, id],
    });
    if (!lineRows.length) return res.status(404).json({ message: 'Line not found' });
    const line = lineRows[0];

    const short = Number(req.body?.short);
    if (!Number.isFinite(short) || short < 0) return res.status(400).json({ message: 'Short must be a number >= 0' });

    const changes = diffFields(line, { short }, ['short']);

    const tx = await db.transaction('write');
    try {
      if (changes.length) {
        await tx.execute({
          sql: `UPDATE outbound_po_lines SET short = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?`,
          args: [short, req.user.id, lineId],
        });
        await logAction({
          client: tx,
          userId: req.user.id,
          actionType: 'OUTBOUND_PO_LINE_SHORT_UPDATE',
          description: `Set Short to ${short} on line "${line.category} - ${line.item_name}${line.variant ? ` - ${line.variant}` : ''}" (PO ${padOrderNo(id)})`,
          entityType: 'outbound_po_line',
          entityId: Number(lineId),
          changes,
        });
      }
      await recomputeAndPersistStatus(tx, Number(id), req.user.id);
      await tx.commit();
    } catch (e) { await tx.rollback(); throw e; }

    const linesByPo = await fetchLines([Number(id)], { withReceipts: true });
    const line2 = (linesByPo.get(Number(id)) || []).find(l => l.id === Number(lineId));
    res.json({ line: line2 });
  } catch (err) { next(err); }
}

// POST /:id/lines/:lineId/receipts — add a new receipt (one delivery/bill).
async function createReceipt(req, res, next) {
  try {
    const { id, lineId } = req.params;
    const { rows: poRows } = await db.execute({ sql: 'SELECT id, status FROM outbound_pos WHERE id = ?', args: [id] });
    if (!poRows.length) return res.status(404).json({ message: 'PO not found' });
    if (poRows[0].status === 'Deleted') return res.status(400).json({ message: 'PO is deleted; restore it first' });

    const { rows: lineRows } = await db.execute({
      sql: 'SELECT id, category, item_name, variant FROM outbound_po_lines WHERE id = ? AND po_id = ? AND deleted_at IS NULL',
      args: [lineId, id],
    });
    if (!lineRows.length) return res.status(404).json({ message: 'Line not found' });
    const line = lineRows[0];

    const receivedQty = Number(req.body?.received_qty);
    if (!Number.isFinite(receivedQty) || receivedQty <= 0) {
      return res.status(400).json({ message: 'Received Qty must be a number > 0' });
    }
    const receivedRate = req.body?.received_rate != null && req.body.received_rate !== ''
      ? Number(req.body.received_rate) : null;
    if (receivedRate != null && (!Number.isFinite(receivedRate) || receivedRate < 0)) {
      return res.status(400).json({ message: 'Received Rate must be a number >= 0' });
    }
    const billNo = req.body?.bill_no != null ? (String(req.body.bill_no).trim() || null) : null;

    const tx = await db.transaction('write');
    try {
      const { rows: inserted } = await tx.execute({
        sql: `INSERT INTO outbound_po_line_receipts (line_id, received_qty, received_rate, bill_no, created_by, updated_by)
              VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
        args: [lineId, receivedQty, receivedRate, billNo, req.user.id, req.user.id],
      });
      await logAction({
        client: tx,
        userId: req.user.id,
        actionType: 'OUTBOUND_PO_LINE_RECEIPT_CREATE',
        description: `Added receipt of ${receivedQty} on line "${line.category} - ${line.item_name}${line.variant ? ` - ${line.variant}` : ''}"${billNo ? `, bill #${billNo}` : ''}${receivedRate != null ? ` @ ${receivedRate}` : ''} (PO ${padOrderNo(id)})`,
        entityType: 'outbound_po_line',
        entityId: Number(lineId),
      });
      await recomputeAndPersistStatus(tx, Number(id), req.user.id);
      await tx.commit();
      res.status(201).json({ id: inserted[0].id });
    } catch (e) { await tx.rollback(); throw e; }
  } catch (err) { next(err); }
}

// PATCH /:id/lines/:lineId/receipts/:receiptId — edit an existing receipt.
async function updateReceipt(req, res, next) {
  try {
    const { id, lineId, receiptId } = req.params;
    const { rows: poRows } = await db.execute({ sql: 'SELECT id, status FROM outbound_pos WHERE id = ?', args: [id] });
    if (!poRows.length) return res.status(404).json({ message: 'PO not found' });
    if (poRows[0].status === 'Deleted') return res.status(400).json({ message: 'PO is deleted; restore it first' });

    const { rows: receiptRows } = await db.execute({
      sql: `SELECT r.id, r.received_qty, r.received_rate, r.bill_no, l.category, l.item_name, l.variant
            FROM outbound_po_line_receipts r
            JOIN outbound_po_lines l ON l.id = r.line_id
            WHERE r.id = ? AND r.line_id = ? AND l.po_id = ? AND r.deleted_at IS NULL`,
      args: [receiptId, lineId, id],
    });
    if (!receiptRows.length) return res.status(404).json({ message: 'Receipt not found' });
    const receipt = receiptRows[0];

    const has = (k) => Object.prototype.hasOwnProperty.call(req.body || {}, k);
    let nextQty = receipt.received_qty;
    if (has('received_qty')) {
      nextQty = Number(req.body.received_qty);
      if (!Number.isFinite(nextQty) || nextQty <= 0) return res.status(400).json({ message: 'Received Qty must be a number > 0' });
    }
    let nextRate = receipt.received_rate;
    if (has('received_rate')) {
      nextRate = req.body.received_rate != null && req.body.received_rate !== '' ? Number(req.body.received_rate) : null;
      if (nextRate != null && (!Number.isFinite(nextRate) || nextRate < 0)) return res.status(400).json({ message: 'Received Rate must be a number >= 0' });
    }
    let nextBillNo = receipt.bill_no;
    if (has('bill_no')) {
      nextBillNo = req.body.bill_no != null ? (String(req.body.bill_no).trim() || null) : null;
    }

    const changes = diffFields(receipt, { received_qty: nextQty, received_rate: nextRate, bill_no: nextBillNo }, ['received_qty', 'received_rate', 'bill_no']);

    const tx = await db.transaction('write');
    try {
      if (changes.length) {
        await tx.execute({
          sql: `UPDATE outbound_po_line_receipts SET received_qty = ?, received_rate = ?, bill_no = ?,
                  updated_by = ?, updated_at = datetime('now') WHERE id = ?`,
          args: [nextQty, nextRate, nextBillNo, req.user.id, receiptId],
        });
        await logAction({
          client: tx,
          userId: req.user.id,
          actionType: 'OUTBOUND_PO_LINE_RECEIPT_UPDATE',
          description: `Updated receipt on line "${receipt.category} - ${receipt.item_name}${receipt.variant ? ` - ${receipt.variant}` : ''}" (PO ${padOrderNo(id)})`,
          entityType: 'outbound_po_line',
          entityId: Number(lineId),
          changes,
        });
      }
      await recomputeAndPersistStatus(tx, Number(id), req.user.id);
      await tx.commit();
    } catch (e) { await tx.rollback(); throw e; }
    res.json({ id: Number(receiptId) });
  } catch (err) { next(err); }
}

// DELETE /:id/lines/:lineId/receipts/:receiptId — soft-delete a receipt.
async function deleteReceipt(req, res, next) {
  try {
    const { id, lineId, receiptId } = req.params;
    const { rows: poRows } = await db.execute({ sql: 'SELECT id, status FROM outbound_pos WHERE id = ?', args: [id] });
    if (!poRows.length) return res.status(404).json({ message: 'PO not found' });
    if (poRows[0].status === 'Deleted') return res.status(400).json({ message: 'PO is deleted; restore it first' });

    const { rows: receiptRows } = await db.execute({
      sql: `SELECT r.id, l.category, l.item_name, l.variant
            FROM outbound_po_line_receipts r
            JOIN outbound_po_lines l ON l.id = r.line_id
            WHERE r.id = ? AND r.line_id = ? AND l.po_id = ? AND r.deleted_at IS NULL`,
      args: [receiptId, lineId, id],
    });
    if (!receiptRows.length) return res.status(404).json({ message: 'Receipt not found' });
    const receipt = receiptRows[0];

    const tx = await db.transaction('write');
    try {
      await tx.execute({
        sql: `UPDATE outbound_po_line_receipts SET deleted_by = ?, deleted_at = datetime('now'), updated_by = ?, updated_at = datetime('now') WHERE id = ?`,
        args: [req.user.id, req.user.id, receiptId],
      });
      await logAction({
        client: tx,
        userId: req.user.id,
        actionType: 'OUTBOUND_PO_LINE_RECEIPT_DELETE',
        description: `Removed a receipt from line "${receipt.category} - ${receipt.item_name}${receipt.variant ? ` - ${receipt.variant}` : ''}" (PO ${padOrderNo(id)})`,
        entityType: 'outbound_po_line',
        entityId: Number(lineId),
      });
      await recomputeAndPersistStatus(tx, Number(id), req.user.id);
      await tx.commit();
    } catch (e) { await tx.rollback(); throw e; }
    res.json({ id: Number(receiptId), deleted: true });
  } catch (err) { next(err); }
}

// POST /:id/lines/:lineId/receipts/:receiptId/restore — restore a soft-deleted receipt.
async function restoreReceipt(req, res, next) {
  try {
    const { id, lineId, receiptId } = req.params;
    const { rows: poRows } = await db.execute({ sql: 'SELECT id, status FROM outbound_pos WHERE id = ?', args: [id] });
    if (!poRows.length) return res.status(404).json({ message: 'PO not found' });
    if (poRows[0].status === 'Deleted') return res.status(400).json({ message: 'PO is deleted; restore it first' });

    const { rows: receiptRows } = await db.execute({
      sql: `SELECT r.id, l.category, l.item_name, l.variant
            FROM outbound_po_line_receipts r
            JOIN outbound_po_lines l ON l.id = r.line_id
            WHERE r.id = ? AND r.line_id = ? AND l.po_id = ? AND r.deleted_at IS NOT NULL`,
      args: [receiptId, lineId, id],
    });
    if (!receiptRows.length) return res.status(404).json({ message: 'Deleted receipt not found' });
    const receipt = receiptRows[0];

    const tx = await db.transaction('write');
    try {
      await tx.execute({
        sql: `UPDATE outbound_po_line_receipts SET deleted_by = NULL, deleted_at = NULL, updated_by = ?, updated_at = datetime('now') WHERE id = ?`,
        args: [req.user.id, receiptId],
      });
      await logAction({
        client: tx,
        userId: req.user.id,
        actionType: 'OUTBOUND_PO_LINE_RECEIPT_RESTORE',
        description: `Restored a receipt on line "${receipt.category} - ${receipt.item_name}${receipt.variant ? ` - ${receipt.variant}` : ''}" (PO ${padOrderNo(id)})`,
        entityType: 'outbound_po_line',
        entityId: Number(lineId),
      });
      await recomputeAndPersistStatus(tx, Number(id), req.user.id);
      await tx.commit();
    } catch (e) { await tx.rollback(); throw e; }
    res.json({ id: Number(receiptId), deleted: false });
  } catch (err) { next(err); }
}

module.exports = {
  list, getOne, create, update, remove, restore,
  updateLineShort, createReceipt, updateReceipt, deleteReceipt, restoreReceipt,
};
