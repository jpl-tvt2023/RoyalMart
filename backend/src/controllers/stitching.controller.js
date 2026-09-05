const db = require('../config/db');
const { logAction, diffFields } = require('../services/auditLog.service');
const { userHasRole } = require('../services/userRoles.service');
const {
  STAGES, OPEN_STATUSES, EPSILON, isValidStage, nextStage, prevStage,
  effectiveAfterRate, statusSql, moneyError, qtyError, revertReasonError,
  challanError, hasChallan,
} = require('../services/stitching.service');

const padOrderNo = (id) => String(id).padStart(3, '0');

// Same cap and reasoning as INCOMING_NO_MAX in outboundPOs.controller.js: free
// text, bounded only so a paste accident cannot land an essay in the column.
const TEXT_MAX = 50;

const PAGE_SIZES = [10, 25, 50, 100];

// Twin of NONE_SELECTED in outboundPOs.controller.js — a multi-select filter with
// everything unticked means "match nothing", which an absent param cannot say.
const NONE_SELECTED = '__none_selected__';

// Position in the processing chain, for ordering. A plain `stage` sort would be
// ALPHABETICAL — Gray, Packed, Processed, Stitched — which puts the end of the
// chain second and makes a lot's history unreadable. Built from STAGES so adding
// a stage cannot leave the ordering behind.
const STAGE_ORDER_SQL = `CASE stage${
  STAGES.map((s, i) => ` WHEN '${s}' THEN ${i + 1}`).join('')
} END`;

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
  // What the All tab asks for: one PO's lots together, reading Gray to Packed.
  // The whole point of that tab is following a single PO through the chain, and
  // the default updated_at order interleaves the stages by edit time instead.
  po_stage: ['po_id', STAGE_ORDER_SQL],
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
  // A sort key may be several expressions (po_stage is "PO, then chain
  // position"). The direction goes on EACH of them: appending it once would
  // leave the leading terms on SQLite's default ASC, so a descending sort would
  // silently only reverse its last column.
  const terms = Array.isArray(col) ? col : [col];
  // id is the tiebreaker so paging stays stable when rows share a timestamp.
  return `ORDER BY ${terms.map(t => `${t} ${dir}`).join(', ')}, id DESC`;
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
    'receipt' AS src, r.id AS id, r.line_id AS line_id, sp.stage AS stage,
    v.name AS party_name, r.bill_no AS bill_no, r.challan_no AS challan_no,
    sp.id AS incoming_prefix_id, sp.prefix AS incoming_prefix, r.incoming_no AS incoming_no,
    r.received_qty AS metre,
    r.received_rate AS rate, r.process_rate AS process_rate,
    COALESCE(r.after_rate, r.received_rate + COALESCE(r.process_rate, 0)) AS after_rate,
    r.checked_by AS checked_by, kb.name AS checked_by_name,
    r.closed_at AS closed_at, r.closed_by AS closed_by, clb.name AS closed_by_name,
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
  LEFT JOIN users clb ON clb.id = r.closed_by
  WHERE r.deleted_at IS NULL

  UNION ALL

  SELECT
    'entry' AS src, e.id AS id, orr.line_id AS line_id, e.stage AS stage,
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
    e.closed_at AS closed_at, e.closed_by AS closed_by, clb.name AS closed_by_name,
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
  LEFT JOIN users clb ON clb.id = e.closed_by
  WHERE e.deleted_at IS NULL
)`;

// Computed once, outside the CTE, so filters and ORDER BY reference them by
// name rather than repeating the expressions.
const LOT_SELECT = `
  SELECT lots.*,
         metre - forwarded AS balance,
         ${statusSql('stage', 'metre', 'forwarded', 'closed_at')} AS status,
         COALESCE(incoming_prefix, '') || COALESCE(incoming_no, '') AS full_incoming_no
  FROM lots`;

// Shared by list() and stageCounts() so the two can never disagree about what a
// filter means. excludeStage omits the stage condition even when present, since
// counting is inherently across stages; excludeStatus omits the status one,
// because a count of open lots must not be narrowed by whatever the user happens
// to have picked in the status dropdown. Mirrors buildListWhere's
// excludeItemName in outboundPOs.controller.js.
function buildWhere(query, { excludeStage = false, excludeStatus = false } = {}) {
  const where = [];
  const args = [];

  if (query.stage && !excludeStage) {
    where.push('stage = ?');
    args.push(query.stage);
  }

  const statuses = String(query.status || '').split(',').map(s => s.trim()).filter(Boolean);
  if (excludeStatus) {
    // nothing — the caller supplies its own status condition
  } else if (statuses.includes(NONE_SELECTED)) {
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
    // Where a send-back would return the metre to. Derived rather than joined
    // because hop creation is forward-only, so an entry's parent is always one
    // stage back — see prevStage's note. Null on a receipt, which is where
    // material entered and so has no parent to go back to.
    parent_stage: row.src === 'entry' ? prevStage(row.stage) : null,
    // A hop can only be sent back while nothing hangs off it and it has not been
    // closed out, so the correction can never strand material downstream.
    can_revert: row.src === 'entry'
      && Number(row.forwarded) <= EPSILON
      && row.closed_at == null,
    // A lot cannot be dispatched without a challan to dispatch it under. Reported
    // rather than folded into can_forward so the button can be shown disabled
    // with the reason on it — a control that silently vanishes teaches nobody
    // why it went.
    challan_missing: !hasChallan(row),
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

// GET /api/stitching/stage-counts — open-lot count per stage, for the tab badges.
//
// Scoped by every OTHER active filter (stage and status excluded), so each badge
// answers "how many open lots would I see if I clicked that tab". Same contract
// as getItemNameCounts in outboundPOs.controller.js.
//
// Reuses LOTS_CTE/LOT_SELECT untouched, so a badge can never disagree with the
// table beneath it. `status` is a LOT_SELECT alias, hence the filter sits in an
// outer query over the subselect — the shape list()'s own count query uses.
async function stageCounts(req, res, next) {
  try {
    const { clause, args } = buildWhere(req.query, { excludeStage: true, excludeStatus: true });
    const placeholders = OPEN_STATUSES.map(() => '?').join(',');
    const { rows } = await db.execute({
      sql: `${LOTS_CTE}
            SELECT stage, COUNT(*) AS n
            FROM (${LOT_SELECT} ${clause})
            WHERE status IN (${placeholders})
            GROUP BY stage`,
      args: [...args, ...OPEN_STATUSES],
    });
    // Every stage present even at zero, so the client never has to guess whether
    // a missing key means none or means the query failed.
    const counts = Object.fromEntries(STAGES.map(s => [s, 0]));
    for (const r of rows) counts[r.stage] = Number(r.n) || 0;
    res.json({ counts });
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
    const err = qtyError(body?.sent_qty, 'Sent Qty');
    if (err) return err;
  }
  if (requireAll || present('metre')) {
    const err = qtyError(body?.metre, 'Received Qty');
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

    // The challan documents the dispatch, and the dispatch IS this forward, so
    // the form collects it here and it is saved onto the PARENT — the lot being
    // sent — rather than onto the row about to be created. A body value
    // overrides whatever the parent already had, which is what lets one form do
    // the whole job instead of making the user set the challan elsewhere first.
    const challanFromBody = req.body?.challan_no != null && String(req.body.challan_no).trim() !== ''
      ? String(req.body.challan_no).trim()
      : null;
    const challanErr = challanError(challanFromBody);
    if (challanErr) return res.status(400).json({ message: challanErr });

    // The gate. Checked against what the parent WILL have, so supplying the
    // challan in this request satisfies it in the same breath.
    if (!challanFromBody && !hasChallan(parent)) {
      return res.status(400).json({
        message: `Add a challan number to this ${parent.stage} lot before sending it ahead`,
      });
    }

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
      // Stamp the dispatch challan onto the parent first, so the lot that moved
      // and the row recording the movement commit together or not at all.
      // TABLE_FOR_SRC is declared further down the file, which is fine: this runs
      // per request, long after the module finished evaluating.
      if (challanFromBody && challanFromBody !== parent.challan_no) {
        await tx.execute({
          sql: `UPDATE ${TABLE_FOR_SRC[parentSrc]} SET challan_no = ?,
                  updated_by = ?, updated_at = datetime('now') WHERE id = ?`,
          args: [challanFromBody, req.user.id, parent.id],
        });
      }

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
          // challan_no is deliberately NULL on the new row: it belongs to the lot
          // being sent, and this one has just arrived. It gets filled in when
          // this lot is itself dispatched onward.
          trimOrNull(req.body.bill_no), null,
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
        message: `Received Qty cannot be less than ${lot.forwarded}, already forwarded from this lot`,
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
        // revert_reason goes with it: a row that is live again is not retired,
        // and a reason left behind on it would read as a lie. The audit entry
        // keeps the reason permanently, so nothing is actually lost.
        sql: `UPDATE stitching_entries SET deleted_by = NULL, deleted_at = NULL,
                revert_reason = NULL,
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

// Which table a lot lives in. Both kinds can reach Packed — forwarded through
// the chain, or bought directly at that stage — so close/reopen and the journey
// all take the src as part of the identity.
const TABLE_FOR_SRC = { receipt: 'outbound_po_line_receipts', entry: 'stitching_entries' };

function parseLotRef(req) {
  const { src, id } = req.params;
  if (!TABLE_FOR_SRC[src]) return [null, 'Lot type must be "receipt" or "entry"'];
  return [{ src, id: Number(id) }, null];
}

// POST /api/stitching/:src/:id/revert — send a wrongly recorded hop back to the
// stage it came from.
//
// This is a CORRECTION, not rework: nothing physically moved, someone recorded a
// forward against the wrong lot or stage. So the hop is retired rather than
// rewritten, and the reason is mandatory — the whole value of the record is that
// "why is there a retired hop here" stays answerable.
//
// The metre returns to the parent for free. `forwarded` only ever sums children
// with deleted_at IS NULL, so retiring this row raises the parent's balance,
// drops its status back to Pending or Partial, puts it back in its stage's open
// count and makes it forwardable again — with no write against the parent at all.
//
// Forwarding it again afterwards is then an ordinary create(): nothing in that
// path knows or cares that a retired sibling exists.
async function revert(req, res, next) {
  try {
    const [ref, refErr] = parseLotRef(req);
    if (refErr) return res.status(400).json({ message: refErr });

    // A receipt is not a hop — it is where material entered the chain, and
    // correcting it belongs on the PO detail page. Taking the src as part of the
    // identity is also what stops a receipt id silently matching an unrelated
    // entry, since the two tables number their rows independently.
    if (ref.src !== 'entry') {
      return res.status(400).json({
        message: 'Only a forwarded lot can be sent back — this one was received directly on a PO, so correct it on the PO instead',
      });
    }

    const reasonError = revertReasonError(req.body?.reason);
    if (reasonError) return res.status(400).json({ message: reasonError });
    const reason = String(req.body.reason).trim();

    const { rows: existing } = await db.execute({
      sql: `SELECT id, stage, sent_qty, incoming_no, closed_at
            FROM stitching_entries WHERE id = ? AND deleted_at IS NULL`,
      args: [ref.id],
    });
    if (!existing.length) return res.status(404).json({ message: 'Stitching entry not found' });
    const entry = existing[0];

    // Retiring a hop that has itself been forwarded would strand its children on
    // material their parent no longer holds. Same guard, and same wording, as
    // remove() — the chain has to come apart from the far end.
    const { rows: childRows } = await db.execute({
      sql: 'SELECT COUNT(*) AS n FROM stitching_entries WHERE parent_entry_id = ? AND deleted_at IS NULL',
      args: [ref.id],
    });
    const children = Number(childRows[0]?.n) || 0;
    if (children > 0) {
      return res.status(400).json({
        message: `Cannot send this back — ${children} lot(s) have been forwarded from it. Send those back first.`,
      });
    }

    if (entry.closed_at) {
      return res.status(400).json({
        message: 'This lot has been closed — reopen it before sending it back',
      });
    }

    const lot = await loadLot('entry', ref.id);
    const target = prevStage(entry.stage);

    const tx = await db.transaction('write');
    try {
      await tx.execute({
        sql: `UPDATE stitching_entries
                SET deleted_by = ?, deleted_at = datetime('now'), revert_reason = ?,
                    updated_by = ?, updated_at = datetime('now')
              WHERE id = ?`,
        args: [req.user.id, reason, req.user.id, ref.id],
      });
      await logAction({
        client: tx,
        userId: req.user.id,
        actionType: 'STITCHING_ENTRY_REVERT',
        // The reason goes in the description so it outlives a later restore,
        // which clears the column.
        description: `Sent ${entry.sent_qty} back from ${entry.stage} to ${target} `
          + `for ${describeLot(lot)} — ${reason}`,
        entityType: 'stitching_entry',
        entityId: ref.id,
        entityRef: entry.incoming_no,
      });
      await tx.commit();
    } catch (e) { await tx.rollback(); throw e; }

    res.json({ id: ref.id, reverted: true, returned_to: target });
  } catch (err) { next(err); }
}

// Shared by close and reopen: both only apply at the end of the chain, and both
// refuse a no-op rather than silently succeeding — a double-click must not
// rewrite who closed a lot or when.
async function setClosed(req, res, next, { closing }) {
  try {
    const [ref, refErr] = parseLotRef(req);
    if (refErr) return res.status(400).json({ message: refErr });

    const lot = await loadLot(ref.src, ref.id);
    if (!lot) return res.status(404).json({ message: 'Lot not found' });
    if (lot.stage !== 'Packed') {
      return res.status(400).json({
        message: `Only a Packed lot can be ${closing ? 'closed' : 'reopened'} — this one is ${lot.stage}`,
      });
    }
    if (closing && lot.closed_at) {
      return res.status(400).json({ message: 'This lot is already closed' });
    }
    if (!closing && !lot.closed_at) {
      return res.status(400).json({ message: 'This lot is not closed' });
    }

    const table = TABLE_FOR_SRC[ref.src];
    const tx = await db.transaction('write');
    try {
      await tx.execute({
        sql: closing
          ? `UPDATE ${table} SET closed_at = datetime('now'), closed_by = ?,
               updated_by = ?, updated_at = datetime('now') WHERE id = ?`
          : `UPDATE ${table} SET closed_at = NULL, closed_by = NULL,
               updated_by = ?, updated_at = datetime('now') WHERE id = ?`,
        args: closing ? [req.user.id, req.user.id, ref.id] : [req.user.id, ref.id],
      });
      await logAction({
        client: tx,
        userId: req.user.id,
        actionType: closing ? 'STITCHING_LOT_CLOSE' : 'STITCHING_LOT_REOPEN',
        description: `${closing ? 'Closed' : 'Reopened'} Packed lot of ${lot.metre} `
          + `at ${lot.party_name} for ${describeLot(lot)}`,
        // Receipts are audited against their PO line, the way every other receipt
        // action in this app already is.
        entityType: ref.src === 'entry' ? 'stitching_entry' : 'outbound_po_line',
        entityId: ref.src === 'entry' ? ref.id : lot.line_id,
        entityRef: lot.incoming_no,
      });
      await tx.commit();
    } catch (e) { await tx.rollback(); throw e; }

    res.json(outward(await loadLot(ref.src, ref.id)));
  } catch (err) { next(err); }
}

const close = (req, res, next) => setClosed(req, res, next, { closing: true });
const reopen = (req, res, next) => setClosed(req, res, next, { closing: false });

// PATCH /api/stitching/:src/:id/challan — set or clear the challan a lot is
// dispatched under.
//
// Takes the src for the same reason close and reopen do: an origin lot is a PO
// receipt and a downstream lot is a stitching_entries row, and they live in
// different tables. This is the only path by which the Stitching page writes to
// a receipt, and it exists because the challan moved off the outbound PO detail
// page — Bill No already covered what a PO receipt needs — while origin lots
// still have to be dispatchable from here.
//
// Clearing is allowed and is not an error: the only consequence is that the lot
// stops being forwardable, which is create()'s gate doing its job.
async function setChallan(req, res, next) {
  try {
    const [ref, refErr] = parseLotRef(req);
    if (refErr) return res.status(400).json({ message: refErr });

    const lot = await loadLot(ref.src, ref.id);
    if (!lot) return res.status(404).json({ message: 'Lot not found' });

    const err = challanError(req.body?.challan_no);
    if (err) return res.status(400).json({ message: err });
    const next_ = String(req.body?.challan_no ?? '').trim() || null;

    if (next_ === (lot.challan_no || null)) {
      return res.json(outward(await loadLot(ref.src, ref.id)));
    }

    const table = TABLE_FOR_SRC[ref.src];
    const tx = await db.transaction('write');
    try {
      await tx.execute({
        sql: `UPDATE ${table} SET challan_no = ?, updated_by = ?,
                updated_at = datetime('now') WHERE id = ?`,
        args: [next_, req.user.id, ref.id],
      });
      await logAction({
        client: tx,
        userId: req.user.id,
        actionType: 'STITCHING_LOT_CHALLAN',
        description: next_
          ? `Set challan ${next_} on the ${lot.stage} lot for ${describeLot(lot)}`
          : `Cleared the challan on the ${lot.stage} lot for ${describeLot(lot)}`,
        // Receipts are audited against their PO line, the way setClosed and every
        // other receipt action in this app already does it.
        entityType: ref.src === 'entry' ? 'stitching_entry' : 'outbound_po_line',
        entityId: ref.src === 'entry' ? ref.id : lot.line_id,
        entityRef: lot.incoming_no,
      });
      await tx.commit();
    } catch (e) { await tx.rollback(); throw e; }

    res.json(outward(await loadLot(ref.src, ref.id)));
  } catch (err) { next(err); }
}

// GET /api/stitching/journey/:src/:id — the full lineage of whatever lot this
// belongs to, from the PO receipt it entered on down to every Packed leaf.
//
// The lineage is a TREE, not a line: a lot can be split across several forwards
// (send 30, then 30, then 40), so each node can have siblings. One query pulls
// the origin receipt plus every entry sharing its origin_receipt_id — at most a
// handful of rows, four levels deep — and the tree is assembled here.
//
// The response is already flattened into render order with a depth on each node,
// so the component stays dumb and the ordering rule lives in exactly one place.
async function journey(req, res, next) {
  try {
    const [ref, refErr] = parseLotRef(req);
    if (refErr) return res.status(400).json({ message: refErr });

    const anchor = await loadLot(ref.src, ref.id);
    if (!anchor) return res.status(404).json({ message: 'Lot not found' });

    const originId = anchor.origin_receipt_id;
    const { rows } = await db.execute({
      sql: `${LOTS_CTE} ${LOT_SELECT} WHERE origin_receipt_id = ? ORDER BY created_at, id`,
      args: [originId],
    });

    // Deleted lots are excluded by LOTS_CTE, but the point of this view is the
    // record, so they are fetched separately and folded back in marked.
    const { rows: removed } = await db.execute({
      sql: `SELECT e.id, e.stage, e.party_name, e.sent_qty, e.metre, e.deleted_at,
                   e.revert_reason, e.created_at,
                   e.parent_receipt_id, e.parent_entry_id, du.name AS deleted_by_name
            FROM stitching_entries e
            LEFT JOIN users du ON du.id = e.deleted_by
            WHERE e.origin_receipt_id = ? AND e.deleted_at IS NOT NULL
            ORDER BY e.created_at, e.id`,
      args: [originId],
    });

    const nodes = [
      ...rows.map(r => ({ ...outward(r), deleted: false })),
      ...removed.map(r => ({
        src: 'entry',
        id: r.id,
        lot_key: `entry:${r.id}`,
        stage: r.stage,
        party_name: r.party_name,
        sent_qty: r.sent_qty,
        metre: r.metre,
        parent_src: r.parent_receipt_id != null ? 'receipt' : 'entry',
        parent_id: r.parent_receipt_id ?? r.parent_entry_id,
        created_at: r.created_at,
        deleted: true,
        deleted_at: r.deleted_at,
        deleted_by_name: r.deleted_by_name,
        // Present only on a hop that was sent back as a correction. A retired row
        // without one was a plain delete — the distinction is derived from these
        // two columns rather than stored as a flag.
        revert_reason: r.revert_reason,
      })),
    ];

    const byKey = new Map(nodes.map(n => [n.lot_key, n]));
    const childrenOf = new Map();
    for (const n of nodes) {
      if (n.parent_id == null) continue;
      const parentKey = `${n.parent_src}:${n.parent_id}`;
      if (!childrenOf.has(parentKey)) childrenOf.set(parentKey, []);
      childrenOf.get(parentKey).push(n);
    }

    // Retired hops are appended after every live row above, so without this a
    // correction reads backwards: forward, send back, forward again, and the
    // replacement would render above the retired hop it replaced. Sorting each
    // parent's children by when they happened puts the story in order — the
    // wrong hop with its reason, then the right one.
    for (const siblings of childrenOf.values()) {
      siblings.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.id - b.id);
    }

    // Depth-first from the origin, so a lot's own children follow it immediately
    // and a split reads as an indented pair rather than two distant rows.
    const flat = [];
    const walk = (node, depth) => {
      flat.push({
        ...node,
        depth,
        is_anchor: node.src === ref.src && node.id === ref.id,
        // Only meaningful on a downstream hop: what the parent sent minus what
        // actually arrived. Null on the origin, which was not sent by anyone.
        loss: node.sent_qty == null ? null
          : Math.round((Number(node.sent_qty) - Number(node.metre)) * 100) / 100,
        // The challan belongs to the lot that was SENT, so on this hop it is the
        // parent's. Resolved here so the view can print it on the arrow — where
        // the dispatch actually happened — rather than on the node that arrived.
        sent_under_challan: byKey.get(`${node.parent_src}:${node.parent_id}`)?.challan_no ?? null,
      });
      for (const child of childrenOf.get(node.lot_key) || []) walk(child, depth + 1);
    };
    const root = byKey.get(`receipt:${originId}`);
    if (root) walk(root, 0);
    // A chain whose origin receipt lost its prefix drops out of LOTS_CTE, which
    // would otherwise silently return nothing. Fall back to the anchor's subtree
    // so the view degrades to a partial record rather than an empty one.
    else for (const n of nodes.filter(x => !byKey.has(`${x.parent_src}:${x.parent_id}`))) walk(n, 0);

    const live = flat.filter(n => !n.deleted);
    const packed = live.filter(n => n.stage === 'Packed');
    res.json({
      anchor: { src: ref.src, id: ref.id },
      nodes: flat,
      summary: {
        article: anchor.item_name,
        variant: anchor.variant,
        // The whole chain descends from one PO line, so one unit covers every
        // node. Without this the view had no choice but to guess, and it guessed
        // metres -- wrong for anything bought by the piece.
        unit_metric: anchor.unit_metric,
        po_order_no: anchor.po_order_no,
        origin_incoming_no: root ? `${root.incoming_prefix || ''}${root.incoming_no || ''}` : null,
        origin_metre: root ? Number(root.metre) : null,
        origin_rate: root ? Number(root.rate) : null,
        packed_metre: packed.reduce((s, n) => s + Number(n.metre || 0), 0),
        final_rate: packed.length ? Math.max(...packed.map(n => Number(n.after_rate || 0))) : null,
        total_loss: Math.round(live.reduce((s, n) => s + (n.loss || 0), 0) * 100) / 100,
      },
    });
  } catch (err) { next(err); }
}

module.exports = {
  list, listParties, stageCounts, journey,
  create, update, remove, restore, revert, close, reopen, setChallan,
  NONE_SELECTED,
};
