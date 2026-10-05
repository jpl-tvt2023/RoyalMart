const db = require('../config/db');
const { logAction, diffFields } = require('../services/auditLog.service');
const { isValidDateString } = require('../utils/dateValidation');
const { billNoError, billNoConflicts, isBillNoUniqueViolation } = require('../services/billNo');
const { rtvQualifies, DN_DISPOSED } = require('../services/rtv.service');
const { textRef } = require('./rtv.controller');

// The RAMS integration: Tally -> RAMS -> ROMS.
//
// RAMS reads Royal Mart's Tally books and links each marketplace PO to the
// Tally invoice and credit note that settle it. It reads ROMS's references
// here, and writes Tally's numbers back into the manual fields they belong in --
// exactly as Tally prints them (607/RM/26-27), and only through the same rules
// a person editing the page is held to. Every request runs as the tally-sync
// system user (serviceAuth.js), so every write is audited as "Tally Sync".
//
// A write is COMPARE-AND-SET on the value RAMS last read (`expected`): blank,
// or the number staff typed. If a person changed the field since, the write is
// refused and left for them -- a person typing at the same moment always wins.
// Which typed values RAMS may replace is RAMS's policy, not ROMS's: ROMS checks
// only that the field still holds what RAMS saw, and that the new value is one
// ROMS would accept from anyone.

// ---------------------------------------------------------------- references

// What RAMS matches against. The columns mirror RAMS's own reader
// (agent/src/roms/refs.js) so RAMS can switch to this API without a change of
// shape. Each is paged on a stable order.
const REFS = {
  vendors: { select: 'name, is_active', from: 'vendors', order: 'name' },
  products: { select: 'id, sku_code, description, category', from: 'products', order: 'id' },
  'vendor-codes': {
    select: 'c.id, c.vendor, c.vendor_item_code, c.product_id, p.sku_code',
    from: 'product_vendor_codes c JOIN products p ON p.id = c.product_id',
    order: 'c.id',
  },
  pos: {
    select: `po_id, vendor, vendor_po_id, po_date, status, party_name, city, dispatch_date,
             bill_no, bill_date, grn_status, grn_date, grn_qty, grn_number,
             discrepancy_qty, discrepancy_number, created_at, updated_at`,
    from: 'marketplace_pos',
    order: 'po_id',
  },
  // The SKU comes the way ROMS maps it: vendor + item code -> product.
  lines: {
    select: 'l.po_id, l.line_no, l.item_code, l.qty, pr.sku_code',
    from: `marketplace_po_lines l
           JOIN marketplace_pos p ON p.po_id = l.po_id
           LEFT JOIN product_vendor_codes c ON c.vendor = p.vendor AND c.vendor_item_code = l.item_code
           LEFT JOIN products pr ON pr.id = c.product_id`,
    order: 'l.po_id, l.line_no',
  },
  rtv: {
    select: 'id, po_id, rtv_no, dn_number, status, delivered, delivery_date, cn_number, cn_date, updated_at',
    from: 'rtv_returns',
    order: 'id',
  },
};

const REFS_PAGE_SIZE = 500;
const REFS_PAGE_SIZE_MAX = 1000;

// GET /api/integration/refs/:resource?page=1&page_size=500
async function refs(req, res, next) {
  try {
    const ref = Object.prototype.hasOwnProperty.call(REFS, req.params.resource) ? REFS[req.params.resource] : null;
    if (!ref) return res.status(404).json({ message: `Unknown reference — use one of ${Object.keys(REFS).join(', ')}` });
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(REFS_PAGE_SIZE_MAX, Math.max(1, Number.parseInt(req.query.page_size, 10) || REFS_PAGE_SIZE));
    const [{ rows: [{ total }] }, { rows }] = await Promise.all([
      db.execute(`SELECT COUNT(*) AS total FROM ${ref.from}`),
      db.execute({
        sql: `SELECT ${ref.select} FROM ${ref.from} ORDER BY ${ref.order} LIMIT ? OFFSET ?`,
        args: [pageSize, (page - 1) * pageSize],
      }),
    ]);
    res.json({ rows, total: Number(total), page, page_size: pageSize });
  } catch (err) { next(err); }
}

// ---------------------------------------------------------------- auto-fill

const AUTOFILL_MAX_ITEMS = 200;
const NOTE_MAX = 200;

const text = (v) => (v == null || String(v).trim() === '' ? null : String(v).trim());
const reject = (reason) => ({ result: 'rejected', reason });
const changedReason = (field, now, expected) => `${field} is now ${now == null ? 'blank' : `"${now}"`}, not ${expected == null ? 'blank' : `"${expected}"`} as RAMS read it — left for a person`;

// The parts every item shares, or a rejection.
function readItem(item) {
  if (!Object.prototype.hasOwnProperty.call(item, 'expected')) {
    return { error: 'expected is required — the value RAMS read (null for a blank field)' };
  }
  const value = text(item.value);
  const date = text(item.date);
  if (!value) return { error: 'value is required' };
  if (!date || !isValidDateString(date)) return { error: 'date must be a valid YYYY-MM-DD date' };
  return { value, date, expected: text(item.expected), note: text(item.note) && text(item.note).slice(0, NOTE_MAX) };
}

// Builty Bill No + Bill Date.
async function fillBill(item, { user, dryRun }) {
  const { value, date, expected, note, error } = readItem(item);
  if (error) return reject(error);
  const formatError = billNoError(value);
  if (formatError) return reject(formatError);

  const poId = text(item.po_id);
  const { rows } = await db.execute({
    sql: 'SELECT po_id, status, bill_no, bill_date FROM marketplace_pos WHERE po_id = ?',
    args: [poId],
  });
  if (!rows.length) return reject('PO not found');
  const current = rows[0];
  if (current.status === 'Deleted') return reject('PO is deleted');
  if (current.bill_no === value && current.bill_date === date) return { result: 'skipped', reason: 'Already set' };
  if ((current.bill_no ?? null) !== expected) return reject(changedReason('Bill no', current.bill_no, expected));
  if (value !== current.bill_no) {
    const dup = await billNoConflicts(db, value, poId);
    if (dup.length) return reject(`Bill no "${value}" is already used on PO ${dup[0].po_id}`);
  }
  const change = { old: current.bill_no ?? null, new: value };
  if (dryRun) return { result: 'would_apply', ...change };

  const tx = await db.transaction('write');
  try {
    const { rowsAffected } = await tx.execute({
      sql: `UPDATE marketplace_pos SET bill_no = ?, bill_date = ?, updated_by = ?, updated_at = datetime('now')
             WHERE po_id = ? AND status <> 'Deleted' AND bill_no IS ?`,
      args: [value, date, user.id, poId, expected],
    });
    if (!rowsAffected) {
      await tx.rollback();
      return reject('Bill no changed while it was being filled — left for a person');
    }
    await logAction({
      client: tx,
      userId: user.id,
      actionType: 'ORDER_SUMMARY_AUTOFILL',
      description: `Tally Sync set bill no on ${poId}: ${current.bill_no || '—'} → ${value} (${date})${note ? ` — ${note}` : ''}`,
      entityType: 'marketplace_po',
      entityRef: poId,
      changes: diffFields(current, { bill_no: value, bill_date: date }, ['bill_no', 'bill_date']),
    });
    await tx.commit();
    return { result: 'applied', ...change };
  } catch (e) {
    await tx.rollback();
    // The pre-check can miss a bill no another save took a moment ago.
    if (isBillNoUniqueViolation(e)) return reject(`Bill no "${value}" is already used on another PO`);
    throw e;
  }
}

// RTV Credit Note Number + CN Date -- the PATCH /api/rtv/:id rules for those two
// fields: the PO must still be on the RTV page, and a DN - Disposed row takes no
// credit note.
async function fillRtvCn(item, { user, dryRun }) {
  const { value: raw, date, expected, note, error } = readItem(item);
  if (error) return reject(error);
  let value;
  try { value = textRef(raw, 'Credit Note Number'); } catch (e) {
    if (e.status === 400) return reject(e.message);
    throw e;
  }

  const poId = text(item.po_id);
  const { rows } = await db.execute({
    sql: `SELECT r.id, r.po_id, r.rtv_no, r.status, r.cn_number, r.cn_date,
                 p.status AS po_status, p.grn_status, p.discrepancy_qty
            FROM rtv_returns r JOIN marketplace_pos p ON p.po_id = r.po_id
           WHERE r.po_id = ?`,
    args: [poId],
  });
  if (!rows.length) return reject('No RTV row for this PO');
  const current = rows[0];
  if (!rtvQualifies({ status: current.po_status, grn_status: current.grn_status, discrepancy_qty: current.discrepancy_qty })) {
    return reject(`PO ${poId} is no longer returned or short on the GRN page — this RTV is closed to edits`);
  }
  if (current.status === DN_DISPOSED) return reject(`RTV ${current.rtv_no} is ${DN_DISPOSED} — no credit note follows`);
  if (current.cn_number === value && current.cn_date === date) return { result: 'skipped', reason: 'Already set' };
  if ((current.cn_number ?? null) !== expected) return reject(changedReason('Credit Note Number', current.cn_number, expected));
  const change = { old: current.cn_number ?? null, new: value };
  if (dryRun) return { result: 'would_apply', ...change };

  const tx = await db.transaction('write');
  try {
    const { rowsAffected } = await tx.execute({
      sql: `UPDATE rtv_returns SET cn_number = ?, cn_date = ?, updated_by = ?, updated_at = datetime('now')
             WHERE id = ? AND cn_number IS ? AND (status IS NULL OR status <> ?)`,
      args: [value, date, user.id, current.id, expected, DN_DISPOSED],
    });
    if (!rowsAffected) {
      await tx.rollback();
      return reject('Credit Note Number changed while it was being filled — left for a person');
    }
    await logAction({
      client: tx,
      userId: user.id,
      actionType: 'RTV_AUTOFILL',
      description: `Tally Sync set credit note on RTV ${current.rtv_no} (PO ${poId}): ${current.cn_number || '—'} → ${value} (${date})${note ? ` — ${note}` : ''}`,
      entityType: 'rtv_return',
      entityId: Number(current.id),
      changes: diffFields(current, { cn_number: value, cn_date: date }, ['cn_number', 'cn_date']),
    });
    await tx.commit();
    return { result: 'applied', ...change };
  } catch (e) { await tx.rollback(); throw e; }
}

const TARGETS = { bill: fillBill, rtv_cn: fillRtvCn };

// POST /api/integration/autofill
//   { items: [{ target: 'bill' | 'rtv_cn', po_id, value, date, expected, note? }], dry_run? }
// Each item stands alone -- its own checks, its own transaction -- and gets a
// result: applied, would_apply (dry run), skipped (already so) or rejected, with
// the reason. A rejected item never stops the rest.
async function autofill(req, res, next) {
  try {
    const { items, dry_run: dryRun } = req.body || {};
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ message: 'items must be a non-empty array' });
    if (items.length > AUTOFILL_MAX_ITEMS) return res.status(400).json({ message: `At most ${AUTOFILL_MAX_ITEMS} items per request` });

    const results = [];
    for (const [index, item] of items.entries()) {
      const base = { index, target: item?.target ?? null, po_id: item?.po_id ?? null };
      const fill = item && typeof item === 'object' && Object.prototype.hasOwnProperty.call(TARGETS, item.target) ? TARGETS[item.target] : null;
      if (!fill) {
        results.push({ ...base, ...reject(`target must be one of ${Object.keys(TARGETS).join(', ')}`) });
        continue;
      }
      results.push({ ...base, ...(await fill(item, { user: req.user, dryRun: Boolean(dryRun) })) });
    }
    const count = (r) => results.filter((x) => x.result === r).length;
    res.json({
      dry_run: Boolean(dryRun),
      applied: count('applied'), would_apply: count('would_apply'), skipped: count('skipped'), rejected: count('rejected'),
      results,
    });
  } catch (err) { next(err); }
}

module.exports = { refs, autofill, REFS, AUTOFILL_MAX_ITEMS };
