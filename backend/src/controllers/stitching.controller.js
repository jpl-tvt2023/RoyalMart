const db = require('../config/db');
const { logAction, diffFields } = require('../services/auditLog.service');
const { userHasRole } = require('../services/userRoles.service');
const {
  STAGES, EPSILON, isValidStage, nextStage,
  effectiveAfterRate, statusSql, moneyError, qtyError,
} = require('../services/stitching.service');

const padOrderNo = (id) => String(id).padStart(3, '0');

// Same cap and reasoning as INCOMING_NO_MAX in outboundPOs.controller.js: free
// text, bounded only so a paste accident cannot land an essay in the column.
const TEXT_MAX = 50;

const PAGE_SIZES = [10, 25, 50, 100];

// Twin of NONE_SELECTED in outboundPOs.controller.js — a multi-select filter with
// everything unticked means "match nothing", which an absent param cannot say.
const NONE_SELECTED = '__none_selected__';

const SORT_COLUMNS = {
  id: 'id',
  party_name: 'party_name',
  item_name: 'item_name',
  incoming_no: 'full_incoming_no',
  metre: 'metre',
  balance: 'balance',
  after_rate: 'after_rate',
  status: 'status',
  updated_at: 'updated_at',
};

function buildPagination(query) {
  if (String(query.page_size) === 'all') return { page: 1, pageSize: null, offset: 0 };
  const requested = Number(query.page_size);
  const pageSize = PAGE_SIZES.includes(requested) ? requested : 25;
  const page = Math.max(1, Number(query.page) || 1);
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function buildOrderBy(query) {
  const col = SORT_COLUMNS[query.sort_by] || 'updated_at';
  const dir = String(query.sort_dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  // id is the tiebreaker so paging stays stable when rows share a timestamp.
  return `ORDER BY ${col} ${dir}, id DESC`;
}

// Every lot on the Stitching page, both kinds, shaped identically.
//
// Origin lots are outbound PO receipts read IN PLACE, not copies. A receipt
// appears here as soon as it has an incoming prefix, because the prefix is what
// declares which stage the goods arrived at. Downstream lots are
// stitching_entries rows. UNION ALL rather than materialising the origins into
// one table: a copy would need keeping in step across every receipt write path,
// which is exactly the drift outboundPOFlags.js documents avoiding.
//
// `forwarded` is the sum of live children's sent_qty — what LEFT this lot, not
// what arrived at the next stage. The shortfall between the two is process loss
// and belongs to the child, not to this lot's balance.
//
// The carried-in `rate` on a downstream lot is its parent's effective after
// rate, resolved by a single-hop LEFT JOIN rather than stored, so correcting a
// rate upstream flows down the chain. origin_receipt_id is what keeps the
// article and PO one plain JOIN away instead of a recursive walk up the chain.
const LOTS_CTE = `
WITH lots AS (
  SELECT
    'receipt' AS src, r.id AS id, sp.stage AS stage,
    v.name AS party_name, r.bill_no AS bill_no, r.challan_no AS challan_no,
    sp.id AS incoming_prefix_id, sp.prefix AS incoming_prefix, r.incoming_no AS incoming_no,
    r.received_qty AS metre,
    r.received_rate AS rate, r.process_rate AS process_rate,
    COALESCE(r.after_rate, r.received_rate + COALESCE(r.process_rate, 0)) AS after_rate,
    r.checked_by AS checked_by, kb.name AS checked_by_name,
    r.id AS origin_receipt_id, NULL AS parent_src, NULL AS parent_id,
    COALESCE((SELECT SUM(c.sent_qty) FROM stitching_entries c
               WHERE c.parent_receipt_id = r.id AND c.deleted_at IS NULL), 0) AS forwarded,
    NULL AS sent_qty,
    l.category AS category, l.item_name AS item_name, l.variant AS variant,
    l.unit_metric AS unit_metric,
    p.id AS po_id, v.name AS vendor_name,
    r.created_at AS created_at, r.updated_at AS updated_at, ub.name AS updated_by_name
  FROM outbound_po_line_receipts r
  JOIN stitching_prefixes sp ON sp.id = r.incoming_prefix_id
  JOIN outbound_po_lines l ON l.id = r.line_id AND l.deleted_at IS NULL
  JOIN outbound_pos p ON p.id = l.po_id AND p.status <> 'Deleted'
  JOIN outbound_vendors v ON v.id = p.vendor_id
  LEFT JOIN users kb ON kb.id = r.checked_by
  LEFT JOIN users ub ON ub.id = r.updated_by
  WHERE r.deleted_at IS NULL

  UNION ALL

  SELECT
    'entry' AS src, e.id AS id, e.stage AS stage,
    e.party_name AS party_name, e.bill_no AS bill_no, e.challan_no AS challan_no,
    sp.id AS incoming_prefix_id, sp.prefix AS incoming_prefix, e.incoming_no AS incoming_no,
    e.metre AS metre,
    COALESCE(
      CASE WHEN e.parent_receipt_id IS NOT NULL
           THEN COALESCE(pr.after_rate, pr.received_rate + COALESCE(pr.process_rate, 0))
           ELSE pe.after_rate END, 0) AS rate,
    e.process_rate AS process_rate,
    COALESCE(e.after_rate, 0) AS after_rate,
    e.checked_by AS checked_by, kb.name AS checked_by_name,
    e.origin_receipt_id AS origin_receipt_id,
    CASE WHEN e.parent_receipt_id IS NOT NULL THEN 'receipt' ELSE 'entry' END AS parent_src,
    COALESCE(e.parent_receipt_id, e.parent_entry_id) AS parent_id,
    COALESCE((SELECT SUM(c.sent_qty) FROM stitching_entries c
               WHERE c.parent_entry_id = e.id AND c.deleted_at IS NULL), 0) AS forwarded,
    e.sent_qty AS sent_qty,
    l.category AS category, l.item_name AS item_name, l.variant AS variant,
    l.unit_metric AS unit_metric,
    p.id AS po_id, v.name AS vendor_name,
    e.created_at AS created_at, e.updated_at AS updated_at, ub.name AS updated_by_name
  FROM stitching_entries e
  JOIN outbound_po_line_receipts orr ON orr.id = e.origin_receipt_id
  JOIN outbound_po_lines l ON l.id = orr.line_id
  JOIN outbound_pos p ON p.id = l.po_id
  JOIN outbound_vendors v ON v.id = p.vendor_id
  LEFT JOIN stitching_prefixes sp ON sp.id = e.incoming_prefix_id
  LEFT JOIN outbound_po_line_receipts pr ON pr.id = e.parent_receipt_id
  LEFT JOIN stitching_entries pe ON pe.id = e.parent_entry_id
  LEFT JOIN users kb ON kb.id = e.checked_by
  LEFT JOIN users ub ON ub.id = e.updated_by
  WHERE e.deleted_at IS NULL
)`;

// Computed once, outside the CTE, so filters and ORDER BY reference them by
// name rather than repeating the expressions.
const LOT_SELECT = `
  SELECT lots.*,
         metre - forwarded AS balance,
         ${statusSql('stage', 'metre', 'forwarded')} AS status,
         COALESCE(incoming_prefix, '') || COALESCE(incoming_no, '') AS full_incoming_no
  FROM lots`;

function buildWhere(query) {
  const where = [];
  const args = [];

  if (query.stage) {
    where.push('stage = ?');
    args.push(query.stage);
  }

  const statuses = String(query.status || '').split(',').map(s => s.trim()).filter(Boolean);
  if (statuses.includes(NONE_SELECTED)) {
    where.push('1 = 0');
  } else if (statuses.length) {
    where.push(`status IN (${statuses.map(() => '?').join(',')})`);
    args.push(...statuses);
  }

  if (query.party_name) {
    where.push('party_name LIKE ?');
    args.push(`%${query.party_name}%`);
  }
  if (query.item_name) {
    where.push('item_name = ?');
    args.push(query.item_name);
  }
  // Matched against prefix+number so searching the number the way it is printed
  // still finds it, even though the two halves are stored apart.
  if (query.incoming_no) {
    where.push('full_incoming_no LIKE ?');
    args.push(`%${query.incoming_no}%`);
  }
  if (query.bill_no) {
    where.push('bill_no LIKE ?');
    args.push(`%${query.bill_no}%`);
  }
  if (query.challan_no) {
    where.push('challan_no LIKE ?');
    args.push(`%${query.challan_no}%`);
  }
  // Accepts the padded order number the UI shows ("007") as well as a raw id.
  if (query.po_order_no) {
    where.push('po_id = ?');
    args.push(Number(String(query.po_order_no).replace(/^0+/, '')) || 0);
  }

  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
}

const outward = (row) => {
  if (!row) return null;
  return {
    ...row,
    po_order_no: row.po_id != null ? padOrderNo(row.po_id) : null,
    // Unique across both kinds — used as the React key and as what the forward
    // form names when it says which lot it is drawing from.
    lot_key: `${row.src}:${row.id}`,
    next_stage: nextStage(row.stage),
    can_forward: nextStage(row.stage) != null && Number(row.balance) > EPSILON,
  };
};

// GET /api/stitching?stage=Gray&…
async function list(req, res, next) {
  try {
    const stage = req.query.stage;
    if (stage && !isValidStage(stage)) {
      return res.status(400).json({ message: `Stage must be one of ${STAGES.join(', ')}` });
    }
    const { clause, args } = buildWhere(req.query);
    const { page, pageSize, offset } = buildPagination(req.query);

    const { rows: countRows } = await db.execute({
      sql: `${LOTS_CTE} SELECT COUNT(*) AS total FROM (${LOT_SELECT} ${clause})`,
      args,
    });
    const total = Number(countRows[0]?.total) || 0;

    const limitClause = pageSize == null ? '' : 'LIMIT ? OFFSET ?';
    const listArgs = pageSize == null ? args : [...args, pageSize, offset];
    const { rows } = await db.execute({
      sql: `${LOTS_CTE} ${LOT_SELECT} ${clause} ${buildOrderBy(req.query)} ${limitClause}`,
      args: listArgs,
    });

    res.json({ rows: rows.map(outward), total, page, page_size: pageSize ?? 'all' });
  } catch (err) { next(err); }
}

// GET /api/stitching/parties — datalist for the free-text Party Name field.
// Outbound vendors plus every party already typed on a stage entry, so spelling
// stays consistent until a party master exists.
async function listParties(req, res, next) {
  try {
    const { rows } = await db.execute(
      `SELECT name FROM outbound_vendors WHERE is_active = 1
       UNION
       SELECT party_name AS name FROM stitching_entries WHERE deleted_at IS NULL
       ORDER BY name COLLATE NOCASE ASC`
    );
    res.json(rows.map(r => r.name));
  } catch (err) { next(err); }
}

// Load one lot of either kind, with the numbers a forward has to validate
// against. Returns null when it does not exist or is soft-deleted.
async function loadLot(src, id, client) {
  const executor = client || db;
  const { rows } = await executor.execute({
    sql: `${LOTS_CTE} ${LOT_SELECT} WHERE src = ? AND id = ?`,
    args: [src, id],
  });
  return rows[0] || null;
}

const trimOrNull = (v) => (v != null && String(v).trim() !== '' ? String(v).trim() : null);
const numOrNull = (v) => (v != null && v !== '' ? Number(v) : null);

// Shared by create and update. `requireAll` distinguishes create (absent fields
// are errors) from PATCH (only fields actually present are checked) — the same
// idiom as validateReceiptFields in outboundPOs.controller.js.
async function validateEntryFields(body, { requireAll, targetStage }) {
  const present = (k) => Object.prototype.hasOwnProperty.call(body || {}, k);

  if (requireAll || present('party_name')) {
    const p = trimOrNull(body?.party_name);
    if (!p) return 'Party Name is required';
    if (p.length > TEXT_MAX) return `Party Name must be ${TEXT_MAX} characters or less`;
  }

  if (requireAll || present('sent_qty')) {
    const err = qtyError(body?.sent_qty, 'Sent Metre');
    if (err) return err;
  }
  if (requireAll || present('metre')) {
    const err = qtyError(body?.metre, 'Received Metre');
    if (err) return err;
  }

  if (present('process_rate')) {
    const err = moneyError(body.process_rate, 'Process Rate');
    if (err) return err;
  }
  if (present('after_rate')) {
    const err = moneyError(body.after_rate, 'After Rate');
    if (err) return err;
  }

  if (requireAll || present('checked_by')) {
    if (body?.checked_by == null || body.checked_by === '') return 'Checked By is required';
    const { rows } = await db.execute({ sql: 'SELECT id FROM users WHERE id = ?', args: [body.checked_by] });
    if (!rows.length) return 'Checked By: user not found';
    if (!(await userHasRole(body.checked_by, 'Warehouse_POC'))) {
      return 'Checked By must be a user tagged Warehouse_POC';
    }
  }

  for (const [key, label] of [['bill_no', 'Bill No'], ['challan_no', 'Challan No'], ['incoming_no', 'Incoming No']]) {
    if (present(key) && body[key] != null && body[key] !== '') {
      const s = String(body[key]).trim();
      if (!s) return `${label} cannot be blank`;
      if (s.length > TEXT_MAX) return `${label} must be ${TEXT_MAX} characters or less`;
    }
  }

  // The prefix is optional here — unlike on a receipt, a stage entry's stage is
  // already fixed by its parent, so the prefix is a register reference rather
  // than what routes the lot. But a prefix disagreeing with the stage the lot is
  // actually at would print a misleading number, so that is refused.
  if (present('incoming_prefix_id') && body.incoming_prefix_id != null && body.incoming_prefix_id !== '') {
    const { rows } = await db.execute({
      sql: 'SELECT id, prefix, stage, is_active FROM stitching_prefixes WHERE id = ?',
      args: [body.incoming_prefix_id],
    });
    if (!rows.length) return 'Incoming No prefix not found';
    if (!rows[0].is_active) return `Incoming No prefix "${rows[0].prefix}" is inactive`;
    if (targetStage && rows[0].stage !== targetStage) {
      return `Prefix "${rows[0].prefix}" belongs to the ${rows[0].stage} stage, but this lot is ${targetStage}`;
    }
  }

  return null;
}

const describeLot = (lot) => `${lot.item_name}${lot.variant ? ` - ${lot.variant}` : ''} (PO ${padOrderNo(lot.po_id)})`;

// POST /api/stitching — forward part or all of a lot to the next stage.
async function create(req, res, next) {
  try {
    const parentSrc = req.body?.parent_src;
    const parentId = req.body?.parent_id;
    if (parentSrc !== 'receipt' && parentSrc !== 'entry') {
      return res.status(400).json({ message: 'parent_src must be "receipt" or "entry"' });
    }
    if (parentId == null || parentId === '') {
      return res.status(400).json({ message: 'parent_id is required' });
    }

    const parent = await loadLot(parentSrc, Number(parentId));
    if (!parent) return res.status(404).json({ message: 'Lot not found' });

    // Stage is never user-selected: material physically moves one stage at a
    // time, so the target is always a function of where the parent is now.
    const targetStage = nextStage(parent.stage);
    if (!targetStage) {
      return res.status(400).json({ message: 'This lot is already Packed — there is no next stage' });
    }

    const validationError = await validateEntryFields(req.body, { requireAll: true, targetStage });
    if (validationError) return res.status(400).json({ message: validationError });

    const sentQty = Number(req.body.sent_qty);
    if (sentQty - Number(parent.balance) > EPSILON) {
      return res.status(400).json({
        message: `Cannot send ${sentQty} — only ${parent.balance} is left on this lot`,
      });
    }

    const metre = Number(req.body.metre);
    const processRate = numOrNull(req.body.process_rate);
    const afterRate = req.body.after_rate != null && req.body.after_rate !== ''
      ? Number(req.body.after_rate)
      : effectiveAfterRate(parent.after_rate, processRate, null);

    const originReceiptId = parentSrc === 'receipt' ? parent.id : parent.origin_receipt_id;
    const partyName = trimOrNull(req.body.party_name);

    const tx = await db.transaction('write');
    try {
      const { rows: inserted } = await tx.execute({
        sql: `INSERT INTO stitching_entries
                (stage, origin_receipt_id, parent_receipt_id, parent_entry_id, party_name,
                 bill_no, challan_no, incoming_prefix_id, incoming_no,
                 sent_qty, metre, process_rate, after_rate, checked_by, created_by, updated_by)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        args: [
          targetStage, originReceiptId,
          parentSrc === 'receipt' ? parent.id : null,
          parentSrc === 'entry' ? parent.id : null,
          partyName,
          trimOrNull(req.body.bill_no), trimOrNull(req.body.challan_no),
          numOrNull(req.body.incoming_prefix_id), trimOrNull(req.body.incoming_no),
          sentQty, metre, processRate, afterRate, Number(req.body.checked_by),
          req.user.id, req.user.id,
        ],
      });
      await logAction({
        client: tx,
        userId: req.user.id,
        actionType: 'STITCHING_ENTRY_CREATE',
        description: `Sent ${sentQty} from ${parent.stage} to ${targetStage} (received ${metre}) `
          + `for ${describeLot(parent)} at ${partyName}`,
        entityType: 'stitching_entry',
        entityId: inserted[0].id,
        entityRef: trimOrNull(req.body.incoming_no),
      });
      await tx.commit();
      res.status(201).json({ id: inserted[0].id, stage: targetStage });
    } catch (e) { await tx.rollback(); throw e; }
  } catch (err) { next(err); }
}

// PATCH /api/stitching/:id
async function update(req, res, next) {
  try {
    const { id } = req.params;
    const { rows: existing } = await db.execute({
      sql: 'SELECT * FROM stitching_entries WHERE id = ? AND deleted_at IS NULL',
      args: [id],
    });
    if (!existing.length) return res.status(404).json({ message: 'Stitching entry not found' });
    const current = existing[0];

    const lot = await loadLot('entry', Number(id));
    const has = (k) => Object.prototype.hasOwnProperty.call(req.body || {}, k);

    const validationError = await validateEntryFields(req.body, { requireAll: false, targetStage: current.stage });
    if (validationError) return res.status(400).json({ message: validationError });

    const nextSentQty = has('sent_qty') ? Number(req.body.sent_qty) : current.sent_qty;
    const nextMetre = has('metre') ? Number(req.body.metre) : current.metre;

    // Raising sent_qty can overdraw the parent, and lowering metre can strand
    // material this lot has already sent onward. Both are only reachable on an
    // edit, which is why create checks only the first.
    if (has('sent_qty') && nextSentQty !== current.sent_qty) {
      const parentSrc = current.parent_receipt_id != null ? 'receipt' : 'entry';
      const parent = await loadLot(parentSrc, current.parent_receipt_id ?? current.parent_entry_id);
      // This row's own sent_qty is part of what the parent currently counts as
      // forwarded, so it has to be added back before comparing.
      const available = Number(parent?.balance ?? 0) + Number(current.sent_qty);
      if (nextSentQty - available > EPSILON) {
        return res.status(400).json({
          message: `Cannot send ${nextSentQty} — only ${available} is available on the source lot`,
        });
      }
    }
    if (has('metre') && lot && nextMetre < Number(lot.forwarded) - EPSILON) {
      return res.status(400).json({
        message: `Received Metre cannot be less than ${lot.forwarded}, already forwarded from this lot`,
      });
    }

    const nextProcessRate = has('process_rate') ? numOrNull(req.body.process_rate) : current.process_rate;
    // Same rule as on receipts: After Rate keeps following its default until the
    // user pins it, so editing Process Rate cannot leave a stale price behind.
    const carriedRate = lot ? Number(lot.rate) : 0;
    let nextAfterRate = current.after_rate;
    if (has('after_rate')) {
      nextAfterRate = numOrNull(req.body.after_rate);
    } else if (has('process_rate')) {
      const wasDefault = current.after_rate == null
        || Math.abs(current.after_rate - effectiveAfterRate(carriedRate, current.process_rate, null)) <= EPSILON;
      if (wasDefault) nextAfterRate = effectiveAfterRate(carriedRate, nextProcessRate, null);
    }
    if (nextAfterRate == null) nextAfterRate = effectiveAfterRate(carriedRate, nextProcessRate, null);

    const next = {
      party_name: has('party_name') ? trimOrNull(req.body.party_name) : current.party_name,
      bill_no: has('bill_no') ? trimOrNull(req.body.bill_no) : current.bill_no,
      challan_no: has('challan_no') ? trimOrNull(req.body.challan_no) : current.challan_no,
      incoming_prefix_id: has('incoming_prefix_id') ? numOrNull(req.body.incoming_prefix_id) : current.incoming_prefix_id,
      incoming_no: has('incoming_no') ? trimOrNull(req.body.incoming_no) : current.incoming_no,
      sent_qty: nextSentQty,
      metre: nextMetre,
      process_rate: nextProcessRate,
      after_rate: nextAfterRate,
      checked_by: has('checked_by') ? Number(req.body.checked_by) : current.checked_by,
    };

    const changes = diffFields(current, next, Object.keys(next));

    const tx = await db.transaction('write');
    try {
      if (changes.length) {
        await tx.execute({
          sql: `UPDATE stitching_entries SET party_name = ?, bill_no = ?, challan_no = ?,
                  incoming_prefix_id = ?, incoming_no = ?, sent_qty = ?, metre = ?,
                  process_rate = ?, after_rate = ?, checked_by = ?,
                  updated_by = ?, updated_at = datetime('now')
                WHERE id = ?`,
          args: [next.party_name, next.bill_no, next.challan_no, next.incoming_prefix_id,
            next.incoming_no, next.sent_qty, next.metre, next.process_rate, next.after_rate,
            next.checked_by, req.user.id, id],
        });
        await logAction({
          client: tx,
          userId: req.user.id,
          actionType: 'STITCHING_ENTRY_UPDATE',
          description: `Updated ${current.stage} lot #${id}${lot ? ` for ${describeLot(lot)}` : ''}`,
          entityType: 'stitching_entry',
          entityId: Number(id),
          entityRef: next.incoming_no,
          changes,
        });
      }
      await tx.commit();
    } catch (e) { await tx.rollback(); throw e; }

    res.json(outward(await loadLot('entry', Number(id))));
  } catch (err) { next(err); }
}

// DELETE /api/stitching/:id — soft delete, refused while anything hangs off it.
async function remove(req, res, next) {
  try {
    const { id } = req.params;
    const { rows: existing } = await db.execute({
      sql: 'SELECT id, stage, incoming_no FROM stitching_entries WHERE id = ? AND deleted_at IS NULL',
      args: [id],
    });
    if (!existing.length) return res.status(404).json({ message: 'Stitching entry not found' });

    const { rows: childRows } = await db.execute({
      sql: 'SELECT COUNT(*) AS n FROM stitching_entries WHERE parent_entry_id = ? AND deleted_at IS NULL',
      args: [id],
    });
    const children = Number(childRows[0]?.n) || 0;
    if (children > 0) {
      return res.status(400).json({
        message: `Cannot delete this lot — ${children} lot(s) have been forwarded from it. Remove those first.`,
      });
    }

    const tx = await db.transaction('write');
    try {
      await tx.execute({
        sql: `UPDATE stitching_entries SET deleted_by = ?, deleted_at = datetime('now'),
                updated_by = ?, updated_at = datetime('now') WHERE id = ?`,
        args: [req.user.id, req.user.id, id],
      });
      await logAction({
        client: tx,
        userId: req.user.id,
        actionType: 'STITCHING_ENTRY_DELETE',
        description: `Removed ${existing[0].stage} lot #${id}`,
        entityType: 'stitching_entry',
        entityId: Number(id),
        entityRef: existing[0].incoming_no,
      });
      await tx.commit();
    } catch (e) { await tx.rollback(); throw e; }
    res.json({ id: Number(id), deleted: true });
  } catch (err) { next(err); }
}

// POST /api/stitching/:id/restore
async function restore(req, res, next) {
  try {
    const { id } = req.params;
    const { rows: existing } = await db.execute({
      sql: `SELECT id, stage, sent_qty, incoming_no, parent_receipt_id, parent_entry_id
            FROM stitching_entries WHERE id = ? AND deleted_at IS NOT NULL`,
      args: [id],
    });
    if (!existing.length) return res.status(404).json({ message: 'Deleted stitching entry not found' });
    const entry = existing[0];

    // The source may have been forwarded elsewhere since this row was deleted,
    // so restoring it can overdraw a lot that balanced a moment ago.
    const parentSrc = entry.parent_receipt_id != null ? 'receipt' : 'entry';
    const parent = await loadLot(parentSrc, entry.parent_receipt_id ?? entry.parent_entry_id);
    if (!parent) return res.status(400).json({ message: 'The source lot no longer exists' });
    if (Number(entry.sent_qty) - Number(parent.balance) > EPSILON) {
      return res.status(400).json({
        message: `Cannot restore — this lot took ${entry.sent_qty}, but only ${parent.balance} is left on the source`,
      });
    }

    const tx = await db.transaction('write');
    try {
      await tx.execute({
        sql: `UPDATE stitching_entries SET deleted_by = NULL, deleted_at = NULL,
                updated_by = ?, updated_at = datetime('now') WHERE id = ?`,
        args: [req.user.id, id],
      });
      await logAction({
        client: tx,
        userId: req.user.id,
        actionType: 'STITCHING_ENTRY_RESTORE',
        description: `Restored ${entry.stage} lot #${id}`,
        entityType: 'stitching_entry',
        entityId: Number(id),
        entityRef: entry.incoming_no,
      });
      await tx.commit();
    } catch (e) { await tx.rollback(); throw e; }
    res.json({ id: Number(id), deleted: false });
  } catch (err) { next(err); }
}

module.exports = { list, listParties, create, update, remove, restore, NONE_SELECTED };
