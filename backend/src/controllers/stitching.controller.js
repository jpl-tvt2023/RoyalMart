const db = require('../config/db');
const { logAction, diffFields } = require('../services/auditLog.service');
const { userHasRole } = require('../services/userRoles.service');
const {
  STAGES, OPEN_STATUSES, EPSILON, isValidStage, nextStage,
  EXIT_STAGE, STOCK_STAGE, destinationsFor, canSendTo,
  countsDozens, balanceUnitFor, DOZEN_STAGES, CHALLAN_RATE_UNIT, metresPerDozen,
  PARTY_USE_STAGES, CHALLAN_TYPES, isValidPartyUse, isValidChallanType,
  partyTag, rateTotal,
  effectiveAfterRate, statusSql, moneyError, qtyError, challanError,
  revertReasonError, writeOffReasonError,
} = require('../services/stitching.service');

// The dozen stages as a SQL list, built from the constant so the two can never
// disagree about which lots count dozens.
const DOZEN_STAGES_SQL = DOZEN_STAGES.map(s => `'${s}'`).join(', ');

const padOrderNo = (id) => String(id).padStart(3, '0');

// Same cap and reasoning as INCOMING_NO_MAX in outboundPOs.controller.js: free
// text, bounded only so a paste accident cannot land an essay in the column.
const TEXT_MAX = 50;

const PAGE_SIZES = [10, 25, 50, 100];

// Twin of NONE_SELECTED in outboundPOs.controller.js — a multi-select filter with
// everything unticked means "match nothing", which an absent param cannot say.
const NONE_SELECTED = '__none_selected__';

// Position in the processing chain, for ordering. A plain `stage` sort would be
// ALPHABETICAL — Packing, Panchal, Processing, Stitching — which puts the end of
// the chain first and makes a lot's history unreadable. Built from STAGES so adding
// a stage cannot leave the ordering behind.
const STAGE_ORDER_SQL = `CASE stage${
  STAGES.map((s, i) => ` WHEN '${s}' THEN ${i + 1}`).join('')
} END`;

const SORT_COLUMNS = {
  id: 'id',
  party_name: 'party_name',
  item_name: 'item_name',
  incoming_no: 'full_incoming_no',
  received_qty: 'received_qty',
  balance: 'balance',
  after_rate: 'after_rate',
  status: 'status',
  updated_at: 'updated_at',
  // What the All tab asks for: one PO's lots together, in chain order.
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
// `forwarded` is the sum of live children's sent quantity IN THIS LOT'S UNIT --
// sent_qty (metres) out of a Processing lot, sent_dozens out of any lot that
// counts dozens -- and `qty_basis` is the lot's own quantity in that same unit.
// It is what LEFT this lot, not what arrived at the next stage. The shortfall between the two is SHORT and
// belongs to the child, not to this lot's balance. Write-offs are children too,
// which is the whole reason they were modelled as rows: material written off
// leaves the lot through this same sum, with no change to the arithmetic here.
//
// The carried-in `rate` on a downstream lot is its parent's effective after
// rate, resolved by a single-hop LEFT JOIN rather than stored, so correcting a
// rate upstream flows down the chain. origin_receipt_id is what keeps the
// article and PO one plain JOIN away instead of a recursive walk up the chain.
const LOTS_CTE = `
WITH lots AS (
  SELECT
    'receipt' AS src, r.id AS id, r.line_id AS line_id, sp.stage AS stage,
    v.name AS party_name,
    -- Not r.challan_no. That column is legacy: the PO screen stopped managing a
    -- challan number when challans became records of their own here, so surfacing
    -- it would print a number nobody can see the source of -- which is exactly
    -- what put a stale 12345 on an origin lot. A challan belongs to a dispatch, and
    -- an origin lot is not one.
    NULL AS challan_no,
    -- An origin lot was never dispatched, so it carries no challan and therefore
    -- no challan type. Same reasoning as the NULL challan_no directly above.
    NULL AS challan_type,
    sp.id AS incoming_prefix_id, sp.prefix AS incoming_prefix, r.incoming_no AS incoming_no,
    -- METRES, not the receipt's own quantity. Fabric is bought in taga and
    -- worked in metres, and every stage here counts the metres -- so the origin
    -- lot's quantity is the conversion the user entered on the receipt.
    r.qty_in_metres AS received_qty,
    -- Only ever set on a receipt bought straight in at a stage that counts
    -- dozens, which is everything from Stitching on.
    r.received_dozens AS received_dozens,
    -- What the lot's balance is kept in: dozens at a dozen stage, else metres.
    CASE WHEN sp.stage IN (${DOZEN_STAGES_SQL}) THEN r.received_dozens ELSE r.qty_in_metres END AS qty_basis,
    -- The PO quantity in metres. On an origin lot it is the lot's own metres.
    r.qty_in_metres AS po_qty_metres,
    NULL AS sent_dozens,
    NULL AS challan_line_no,
    NULL AS parent_stage,
    r.received_rate AS rate,
    -- THE PO RATE: what the fabric was billed at on the purchase order. It is
    -- the one rate every lot in a chain shares, and downstream lots read it off
    -- this same origin receipt rather than carrying a copy.
    --
    -- Column ORDER matters from here down: the two halves of this UNION ALL are
    -- matched by position, not by name, so a column added to one must be added
    -- to the other in the same place.
    r.received_rate AS po_rate,
    -- THIS STAGE'S OWN RATE, and only this stage's. On a receipt that is the
    -- cost of the processing already done when we bought it -- a lot bought in
    -- at Processing was billed for processing. Rates no longer accumulate into a
    -- running after_rate: each stage keeps its own figure and the ladder is
    -- assembled by withLineage at read time.
    r.process_rate AS stage_rate,
    r.process_rate AS process_rate,
    -- A receipt's process rate is quoted per metre, like the PO rate beside it.
    'metre' AS rate_unit,
    COALESCE(r.after_rate, r.received_rate + COALESCE(r.process_rate, 0)) AS after_rate,
    NULL AS outbound_bill_no, NULL AS party_id,
    -- The warehouse's own number, set only on a challan sent to Panchal. An
    -- origin receipt was never sent anywhere, so it has none.
    NULL AS panchal_incoming_no,
    r.checked_by AS checked_by, kb.name AS checked_by_name,
    r.closed_at AS closed_at, r.closed_by AS closed_by, clb.name AS closed_by_name,
    -- An origin lot arrived on a PO, so it was never written off by us.
    NULL AS write_off_reason,
    r.id AS origin_receipt_id, NULL AS parent_src, NULL AS parent_id,
    COALESCE((SELECT SUM(CASE WHEN sp.stage IN (${DOZEN_STAGES_SQL}) THEN c.sent_dozens ELSE c.sent_qty END)
                FROM stitching_entries c
               WHERE c.parent_receipt_id = r.id AND c.deleted_at IS NULL), 0) AS forwarded,
    NULL AS sent_qty,
    l.category AS category, l.item_name AS item_name, l.variant AS variant,
    -- The stage's unit, not the line's. The line says taga, which is what was
    -- bought -- every quantity on this page is metres.
    'm' AS unit_metric,
    p.id AS po_id, v.name AS vendor_name,
    r.created_at AS created_at, r.updated_at AS updated_at, ub.name AS updated_by_name
  FROM outbound_po_line_receipts r
  JOIN stitching_prefixes sp ON sp.id = r.incoming_prefix_id
  JOIN outbound_po_lines l ON l.id = r.line_id AND l.deleted_at IS NULL
  -- ONLY FABRIC. Packaging, barcodes and corrugated boxes are received and done
  -- with -- they travel no stage chain, and a lot of corrugated boxes was
  -- what made that obvious. The flag lives on the product master and is reached
  -- through the triple a line carries, since a line holds no product id.
  JOIN outbound_products op ON op.category = l.category AND op.item_name = l.item_name
    AND op.unit_metric = l.unit_metric AND op.goes_to_stitching = 1
  JOIN outbound_pos p ON p.id = l.po_id AND p.status <> 'Deleted'
  JOIN outbound_vendors v ON v.id = p.vendor_id
  LEFT JOIN users kb ON kb.id = r.checked_by
  LEFT JOIN users ub ON ub.id = r.updated_by
  LEFT JOIN users clb ON clb.id = r.closed_by
  -- A fabric receipt with no metres recorded has no quantity to track, so it
  -- waits off the page until someone fills it in rather than appearing as zero.
  WHERE r.deleted_at IS NULL AND r.qty_in_metres IS NOT NULL

  UNION ALL

  SELECT
    'entry' AS src, e.id AS id, orr.line_id AS line_id, e.stage AS stage,
    e.party_name AS party_name, e.challan_no AS challan_no, e.challan_type AS challan_type,
    sp.id AS incoming_prefix_id, sp.prefix AS incoming_prefix, e.incoming_no AS incoming_no,
    e.received_qty AS received_qty,
    e.received_dozens AS received_dozens,
    -- Nothing is ever sent TO Processing, so an entry always counts dozens --
    -- the CASE is kept for symmetry with the receipt half, not as a live branch.
    CASE WHEN e.stage IN (${DOZEN_STAGES_SQL}) THEN e.received_dozens ELSE e.received_qty END AS qty_basis,
    orr.qty_in_metres AS po_qty_metres,
    e.sent_dozens AS sent_dozens,
    e.challan_line_no AS challan_line_no,
    -- The stage this challan LEFT. A challan's rate belongs to it.
    COALESCE(pe.stage, psp.stage) AS parent_stage,
    COALESCE(
      CASE WHEN e.parent_receipt_id IS NOT NULL
           THEN COALESCE(pr.after_rate, pr.received_rate + COALESCE(pr.process_rate, 0))
           ELSE pe.after_rate END, 0) AS rate,
    -- Read off the origin receipt the row already joins, so correcting the PO
    -- rate upstream flows down the whole chain without a stored copy anywhere.
    orr.received_rate AS po_rate,
    e.process_rate AS stage_rate,
    e.process_rate AS process_rate,
    e.rate_unit AS rate_unit,
    COALESCE(e.after_rate, 0) AS after_rate,
    e.outbound_bill_no AS outbound_bill_no, e.party_id AS party_id,
    e.panchal_incoming_no AS panchal_incoming_no,
    e.checked_by AS checked_by, kb.name AS checked_by_name,
    e.closed_at AS closed_at, e.closed_by AS closed_by, clb.name AS closed_by_name,
    -- Present means this row is a write-off rather than a dispatch. One column,
    -- no flag, the way 071 tells a withdrawal from a plain delete.
    e.write_off_reason AS write_off_reason,
    e.origin_receipt_id AS origin_receipt_id,
    CASE WHEN e.parent_receipt_id IS NOT NULL THEN 'receipt' ELSE 'entry' END AS parent_src,
    COALESCE(e.parent_receipt_id, e.parent_entry_id) AS parent_id,
    COALESCE((SELECT SUM(CASE WHEN e.stage IN (${DOZEN_STAGES_SQL}) THEN c.sent_dozens ELSE c.sent_qty END)
                FROM stitching_entries c
               WHERE c.parent_entry_id = e.id AND c.deleted_at IS NULL), 0) AS forwarded,
    e.sent_qty AS sent_qty,
    l.category AS category, l.item_name AS item_name, l.variant AS variant,
    'm' AS unit_metric,
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
  LEFT JOIN stitching_prefixes psp ON psp.id = pr.incoming_prefix_id
  LEFT JOIN users kb ON kb.id = e.checked_by
  LEFT JOIN users ub ON ub.id = e.updated_by
  LEFT JOIN users clb ON clb.id = e.closed_by
  WHERE e.deleted_at IS NULL
)`;

// Computed once, outside the CTE, so filters and ORDER BY reference them by
// name rather than repeating the expressions.
const LOT_SELECT = `
  SELECT lots.*,
         -- In the lot's own unit: metres at Processing, dozens from Stitching on.
         qty_basis - forwarded AS balance,
         -- What was sent but never arrived. NULL on an origin lot, which nobody
         -- sent, which is why it renders blank rather than as a zero.
         sent_qty - received_qty AS short,
         ${statusSql('stage', 'qty_basis', 'forwarded', 'closed_at')} AS status,
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

  // A write-off is not a lot. It records material leaving a lot for the bin, so
  // it belongs under its parent and in the journey, never in a stage's list or
  // its count -- these two are the only paths that treat a row as a lot in its
  // own right, which is why the exclusion lives here and nowhere else.
  where.push('write_off_reason IS NULL');

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

  // The PO party (the outbound vendor every lot in a chain shares) or the party
  // this lot's own challan went to -- the page shows both, so both are searchable.
  if (query.party_name) {
    where.push('(vendor_name LIKE ? OR party_name LIKE ?)');
    args.push(`%${query.party_name}%`, `%${query.party_name}%`);
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
  // A lot's own challan is the one it arrived under, which is only visible from
  // the tab its PARENT is on -- so searching from either side has to work. Hence
  // the EXISTS: match the lot itself, or any live challan raised against it.
  if (query.challan_no) {
    where.push(`(challan_no LIKE ?
      OR EXISTS (SELECT 1 FROM stitching_entries c
                  WHERE c.deleted_at IS NULL AND c.challan_no LIKE ?
                    AND ((lots.src = 'receipt' AND c.parent_receipt_id = lots.id)
                      OR (lots.src = 'entry' AND c.parent_entry_id = lots.id))))`);
    args.push(`%${query.challan_no}%`, `%${query.challan_no}%`);
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
    // Everywhere this lot may go, which is what the destination chooser renders.
    // next_stage survives as the chooser's pre-selection -- the first
    // destination -- not as the only one.
    destinations: destinationsFor(row.stage),
    next_stage: nextStage(row.stage),
    can_forward: destinationsFor(row.stage).length > 0 && Number(row.balance) > EPSILON,
    // What balance, forwarded and every quantity sent out of this lot are in.
    balance_unit: balanceUnitFor(row.stage),
    // A sale is not a lot anyone works on. It shows on its own tab and under its
    // parent, and carries no actions but Journey, History and withdrawal.
    is_exit: row.stage === EXIT_STAGE,
    // Derived, never stored: one number to read, so a stored copy can never
    // disagree with the two it comes from. This is only the lot's OWN yield --
    // a lot sent on from Stitching records dozens alone, so withLineage fills
    // it in from the challan where the metres were converted.
    metres_per_dozen: metresPerDozen(row.received_qty, row.received_dozens),
    // Derived, never stored: one column to read, so a flag can never disagree
    // with the reason beside it.
    is_write_off: row.write_off_reason != null,
    // A challan or a write-off can be withdrawn while nothing hangs off it and it
    // is not closed out. This is a CORRECTION of a record that should not exist,
    // not a movement: no stage is named, because nothing travels anywhere.
    can_remove: row.src === 'entry'
      && Number(row.forwarded) <= EPSILON
      && row.closed_at == null,
  };
};

// THE LINEAGE: everything a lot owes to the challans above it, read off one
// walk up its chain.
//
// Three things on the page need the ancestors and not just the row:
//
// 1. THE RATE TOTAL. A challan's rate belongs to the stage it LEFT -- the rate
//    on a challan out of Processing is the Processing rate -- so each ancestor
//    challan contributes one rung labelled by its parent's stage. The origin
//    receipt contributes the PO rate, plus its own process rate when one was
//    billed. rateTotal in the service turns the rungs into one per-dozen figure,
//    and `rate_breakdown` keeps each rung beside what it contributed so the
//    tooltip can show the working.
//
// 2. METRES PER DOZEN. Only the challan (or receipt) where fabric became pieces
//    records both metres and dozens. A lot sent on from Stitching records dozens
//    alone, so its yield is CARRIED from the nearest ancestor that has both --
//    `m_per_dozen_source` says which one, for the plain-language tooltip.
//
// 3. THE PARTY CHAIN. The page leads with the PO party on every tab and lists
//    each job worker the goods passed through beneath it, as "Stitching - SKT".
//
// A SECOND QUERY keyed on the ids the page returned, like withOutgoing, rather
// than more columns on LOTS_CTE: filtering, sorting and paging all run against
// that CTE, and a recursive walk inside it would be computed for every row in
// the table to render twenty-five. The walk is bounded by the chain -- at most
// five stages -- and terminates because parent_src is NULL exactly once per
// chain, at the origin receipt.
async function withLineage(lots) {
  if (!lots.length) return lots;

  const clauses = [];
  const args = [];
  for (const src of ['receipt', 'entry']) {
    const ids = lots.filter(l => l.src === src).map(l => l.id);
    if (!ids.length) continue;
    clauses.push(`(src = ? AND id IN (${ids.map(() => '?').join(',')}))`);
    args.push(src, ...ids);
  }
  if (!clauses.length) return lots;

  const { rows } = await db.execute({
    sql: `${LOTS_CTE},
    -- Seed: every lot is its own first ancestor, at depth 0, so its own challan
    -- rate and party land in the lineage without a special case.
    chain(lot_src, lot_id, depth, anc_src, anc_id) AS (
      SELECT src, id, 0, src, id FROM lots WHERE ${clauses.join(' OR ')}
      UNION ALL
      SELECT c.lot_src, c.lot_id, c.depth + 1, l.parent_src, l.parent_id
        FROM chain c
        JOIN lots l ON l.src = c.anc_src AND l.id = c.anc_id
       WHERE l.parent_src IS NOT NULL
    )
    SELECT c.lot_src, c.lot_id, c.depth,
           a.src, a.stage, a.parent_stage, a.party_name, pm.short_name,
           a.challan_no, a.challan_type, a.po_rate, a.stage_rate, a.rate_unit,
           a.received_qty, a.received_dozens
      FROM chain c
      JOIN lots a ON a.src = c.anc_src AND a.id = c.anc_id
      LEFT JOIN stitching_parties pm ON pm.name = a.party_name COLLATE NOCASE`,
    args,
  });

  const byLot = new Map();
  for (const row of rows) {
    const key = `${row.lot_src}:${row.lot_id}`;
    if (!byLot.has(key)) byLot.set(key, []);
    byLot.get(key).push(row);
  }

  return lots.map(lot => {
    // Nearest first (depth 0 is the lot itself), which is the order the yield
    // search wants. The rate and party lists read origin-first, so they reverse.
    const nearestFirst = (byLot.get(lot.lot_key) || []).sort((a, b) => a.depth - b.depth);
    const originFirst = [...nearestFirst].reverse();

    const components = [];
    const partyChain = [];
    for (const a of originFirst) {
      if (a.src === 'receipt') {
        components.push({ label: 'PO rate', rate: a.po_rate, unit: 'metre' });
        // Processing (or more) already paid for when the fabric was bought.
        if (a.stage_rate != null) {
          components.push({ label: `${a.stage} rate (on receipt)`, rate: a.stage_rate, unit: 'metre' });
        }
      } else {
        // Labelled by the stage the goods LEFT. rate_unit is NULL only on a row
        // with no rate, which rateTotal skips anyway.
        if (a.stage_rate != null) {
          components.push({
            label: `${a.parent_stage} rate`,
            rate: a.stage_rate,
            unit: a.rate_unit || CHALLAN_RATE_UNIT,
          });
        }
        partyChain.push(partyTag(a.stage, a.party_name, a.short_name));
      }
    }

    // The nearest node that recorded both halves of the conversion.
    const source = nearestFirst.find(a => metresPerDozen(a.received_qty, a.received_dozens) != null);
    const mPerDozen = source ? metresPerDozen(source.received_qty, source.received_dozens) : null;
    // A Processing lot has never been counted in dozens, so it has no yield to
    // show even if something above it did -- there is nothing above it.
    const yieldApplies = countsDozens(lot.stage) && mPerDozen != null;

    const total = rateTotal(components, yieldApplies ? mPerDozen : null);

    return {
      ...lot,
      metres_per_dozen: yieldApplies ? mPerDozen : lot.metres_per_dozen,
      m_per_dozen_source: yieldApplies ? {
        kind: source.src,
        carried: source.depth > 0,
        challan_no: source.challan_no ?? null,
        challan_type: source.challan_type ?? null,
        stage: source.src === 'receipt' ? source.stage : source.parent_stage,
        metres: Number(source.received_qty),
        dozens: Number(source.received_dozens),
      } : null,
      rate_total: total.total,
      rate_total_unit: total.unit,
      rate_breakdown: total.lines,
      party_chain: partyChain,
    };
  });
}

// GET /api/stitching?stage=Processing&…
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

    const lots = rows.map(outward);
    res.json({
      rows: await withLineage(await withOutgoing(lots)),
      total,
      page,
      page_size: pageSize ?? 'all',
    });
  } catch (err) { next(err); }
}

// Hang everything that has LEFT each lot off it -- challans and write-offs alike
// -- the way getOutboundPO hangs receipts off lines: one extra query keyed by the
// ids just returned, never a query per row.
//
// Called `outgoing` rather than `challans` because a write-off is not a challan
// and nothing here should imply it travelled anywhere.
//
// The nested rows come back through LOT_SELECT and outward() exactly like their
// parents, so each reports its own status, balance and flags by the same rules --
// there is no second, drifting definition of any of them. Write-offs are
// deliberately NOT filtered out here: buildWhere drops them from the lot lists,
// and under their parent is precisely where they belong.
async function withOutgoing(lots) {
  if (!lots.length) return lots;

  const idsBySrc = { receipt: [], entry: [] };
  for (const lot of lots) idsBySrc[lot.src].push(lot.id);

  const clauses = [];
  const args = [];
  for (const src of ['receipt', 'entry']) {
    const ids = idsBySrc[src];
    if (!ids.length) continue;
    clauses.push(`(parent_src = ? AND parent_id IN (${ids.map(() => '?').join(',')}))`);
    args.push(src, ...ids);
  }
  if (!clauses.length) return lots;

  const { rows } = await db.execute({
    sql: `${LOTS_CTE} ${LOT_SELECT} WHERE ${clauses.join(' OR ')} ORDER BY created_at, id`,
    args,
  });

  const byParent = new Map();
  for (const row of rows) {
    const key = `${row.parent_src}:${row.parent_id}`;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(outward(row));
  }
  return lots.map(lot => ({ ...lot, outgoing: byParent.get(lot.lot_key) || [] }));
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

// GET /api/stitching/parties?use=Stitching — the party dropdown for a dispatch.
//
// Reads the master migration 079 added. It used to union outbound_vendors with
// every name already typed into a challan, which was a stand-in for exactly this
// table -- and offered every name for every job, since free text knows nothing
// about what a party actually does.
//
// `use` narrows it to parties tagged for that destination, which is the whole
// point of the tags: a non-technical user picking a destination should not then
// be shown a packer for stitching work. Omitting `use` returns every active
// party, which is what an unfiltered list or an export wants.
//
// Only active parties. A deactivated one keeps appearing on the challans already
// raised against it -- party_name is denormalised onto those rows -- it simply
// stops being offered for new ones.
async function listParties(req, res, next) {
  try {
    const use = trimOrNull(req.query?.use);
    if (use && !isValidPartyUse(use)) {
      return res.status(400).json({ message: `use must be one of ${PARTY_USE_STAGES.join(', ')}` });
    }
    const { rows } = await db.execute({
      sql: `SELECT p.name FROM stitching_parties p
             WHERE p.is_active = 1
               ${use ? `AND EXISTS (SELECT 1 FROM stitching_party_uses u
                                     WHERE u.party_id = p.id AND u.use_stage = ?)` : ''}
             ORDER BY p.name COLLATE NOCASE ASC`,
      args: use ? [use] : [],
    });
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

// The fields one LINE of a challan carries. A challan can carry several lines
// -- a Fresh line and a Second line, say -- and each becomes its own lot
// downstream, because the grades travel separately from there.
//
// What a line records depends on the unit of the lot it leaves:
//
// - Out of PROCESSING, the last stage in metres, a line records the metres sent
//   and the dozens that came back. This is where fabric becomes pieces, and the
//   metres-per-dozen of this line is born here.
// - Out of any stage that already counts dozens, a line records its dozens and
//   nothing else. What was sent IS what arrives -- the dozens sent become the
//   next lot's dozens received -- so there is no second number to ask for.
//
// Checked in the order the line's fields sit on the form: type, then quantity.
// `prefix` names the line when a challan has more than one, so the message
// says which row to fix. The client mirrors this, message for message.
function lineFieldsError(line, { requireAll = false, parentDozen = false, prefix = '' } = {}) {
  const present = (k) => Object.prototype.hasOwnProperty.call(line || {}, k);
  const fail = (msg) => `${prefix}${msg}`;

  // Required on create only: rows raised before migration 080 have none, and a
  // PATCH touching an unrelated field must not be forced to invent one.
  if (requireAll || present('challan_type')) {
    const t = trimOrNull(line?.challan_type);
    if (!t) return fail('Challan Type is required');
    if (!isValidChallanType(t)) return fail(`Challan Type must be one of ${CHALLAN_TYPES.join(', ')}`);
  }

  if (parentDozen) {
    // Refused rather than ignored, so a metre figure typed against goods that
    // are counted in dozens surfaces as a question instead of vanishing. First,
    // because it explains the missing Dozens Sent that would otherwise follow.
    if (present('sent_qty') && line.sent_qty != null && line.sent_qty !== '') {
      return fail('Goods are counted in dozens from Stitching on — enter Dozens Sent, not metres');
    }
    if (requireAll || present('sent_dozens')) {
      const err = qtyError(line?.sent_dozens, 'Dozens Sent');
      if (err) return fail(err);
    }
    return null;
  }

  if (requireAll || present('sent_qty')) {
    const err = qtyError(line?.sent_qty, 'Sent Qty');
    if (err) return fail(err);
  }
  // NOT ASKED FOR. A challan records what was SENT -- that is what the document
  // says -- so received_qty defaults to sent_qty. Still honoured when supplied,
  // so an API caller or a correction can record a genuine shortfall.
  if (present('received_qty')) {
    const err = qtyError(line?.received_qty, 'Received Qty');
    if (err) return fail(err);
  }
  // More coming back than went out is a typo, not a windfall.
  if (present('sent_qty') && present('received_qty')
      && Number(line?.received_qty) - Number(line?.sent_qty) > EPSILON) {
    return fail('Received Qty cannot be more than Sent Qty');
  }
  if (requireAll || present('received_dozens')) {
    const err = qtyError(line?.received_dozens, 'Dozens Received');
    if (err) return fail(err);
  }
  return null;
}

// Shared by create and update. `requireAll` distinguishes create (absent fields
// are errors) from PATCH (only fields actually present are checked) — the same
// idiom as validateReceiptFields in outboundPOs.controller.js.
//
// These are the HEADER fields -- one per challan, shared by every line on it --
// in the order they sit at the top of the form. The line fields follow, through
// lineFieldsError, unless the caller validates the lines itself (create does,
// once per line). `sourceStage` names the rate: it belongs to the stage the
// goods are LEAVING.
async function validateEntryFields(body, {
  requireAll = false, targetStage, sourceStage, parentDozen = false, skipLine = false,
} = {}) {
  const present = (k) => Object.prototype.hasOwnProperty.call(body || {}, k);

  if (requireAll || present('party_name')) {
    const p = trimOrNull(body?.party_name);
    if (!p) return 'Party Name is required';
    if (p.length > TEXT_MAX) return `Party Name must be ${TEXT_MAX} characters or less`;
  }

  if (requireAll) {
    const challan = trimOrNull(body?.challan_no);
    if (!challan) return 'Challan No is required';
  }

  if (present('process_rate')) {
    const err = moneyError(body.process_rate, sourceStage ? `${sourceStage} rate` : 'Rate');
    if (err) return err;
  }
  if (present('after_rate')) {
    const err = moneyError(body.after_rate, 'After Rate');
    if (err) return err;
  }

  // Checked By is asked at two destinations and stamped everywhere else.
  //
  // It used to be a required dropdown on every hand-over, which made each one
  // wait on picking a name the person filling the form already knew: their own.
  // For a move between job workers it still records WHO ENTERED THE CHALLAN,
  // taken from the session, and every logged-in user qualifies to have done
  // that.
  //
  // The two exceptions are the hand-overs that are a genuine second pair of
  // eyes rather than the typist's own name: goods arriving in OUR warehouse,
  // and goods leaving the business. There it is a real qualification again, and
  // the same one the outbound receipt used to enforce -- a user tagged
  // Warehouse_POC -- with the message strings reproduced verbatim so both
  // modules reject in identical wording.
  //
  // Outside those two it is still validated when explicitly supplied, so an API
  // caller cannot attach a challan to a user id that does not exist.
  const checkerRequired = targetStage === STOCK_STAGE || targetStage === EXIT_STAGE;
  if (checkerRequired && (requireAll || present('checked_by'))) {
    if (body?.checked_by == null || String(body.checked_by).trim() === '') {
      return 'Checked By is required';
    }
    const { rows } = await db.execute({ sql: 'SELECT id FROM users WHERE id = ?', args: [body.checked_by] });
    if (!rows.length) return 'Checked By: user not found';
    if (!(await userHasRole(rows[0].id, 'Warehouse_POC'))) {
      return 'Checked By must be a user tagged Warehouse_POC';
    }
  } else if (present('checked_by') && body.checked_by != null && body.checked_by !== '') {
    const { rows } = await db.execute({ sql: 'SELECT id FROM users WHERE id = ?', args: [body.checked_by] });
    if (!rows.length) return 'Checked By: user not found';
  }

  // Outbound Bill No belongs to a SALE, and only to a sale.
  //
  // A challan is not a bill -- that is still true of every hand-over inside the
  // chain, and the receipt's Bill No is still the only bill number on a purchase.
  // But a dispatch to a third party is goods leaving the business against our own
  // outbound invoice, and that number is the only handle on it: no incoming
  // number is derived for the exit, because nothing arrives.
  //
  // Rejected on anything else rather than ignored, so a bill number typed against
  // an internal move surfaces as a question instead of vanishing.
  if (targetStage === EXIT_STAGE) {
    if (requireAll || present('outbound_bill_no')) {
      const bill = trimOrNull(body?.outbound_bill_no);
      if (!bill) return 'Outbound Bill No is required when sending to a third party';
      if (bill.length > TEXT_MAX) return `Outbound Bill No must be ${TEXT_MAX} characters or less`;
    }
  } else if (present('outbound_bill_no') && trimOrNull(body?.outbound_bill_no)) {
    return 'Outbound Bill No applies only to goods sold to a third party';
  }

  // PCL Inc No belongs to the WAREHOUSE, and only to the warehouse.
  //
  // Panchal is ours, not a job worker: what lands there is filed under the
  // warehouse's own sequence, which is the number someone quotes when they go
  // looking for the stock on a shelf. It is deliberately NOT the incoming_no
  // carried down the chain -- that suffix is inherited from the parent and is
  // the only thing tying a Panchal lot back to the fabric it was cut from, so
  // the two are separate columns rather than one overwriting the other.
  //
  // Rejected elsewhere rather than ignored, the same way the bill number above
  // is, so a warehouse number typed against a dyeing challan surfaces as a
  // question instead of vanishing.
  if (targetStage === STOCK_STAGE) {
    if (requireAll || present('panchal_incoming_no')) {
      const pcl = trimOrNull(body?.panchal_incoming_no);
      if (!pcl) return 'PCL Inc No is required when sending to Panchal';
      if (pcl.length > TEXT_MAX) return `PCL Inc No must be ${TEXT_MAX} characters or less`;
    }
  } else if (present('panchal_incoming_no') && trimOrNull(body?.panchal_incoming_no)) {
    return 'PCL Inc No applies only to goods sent to Panchal';
  }

  if (present('challan_no') && body.challan_no != null && body.challan_no !== '') {
    const err = challanError(body.challan_no);
    if (err) return err;
  }

  if (!skipLine) {
    const lineErr = lineFieldsError(body, { requireAll, parentDozen });
    if (lineErr) return lineErr;
  }
  if (present('incoming_no') && body.incoming_no != null && body.incoming_no !== '') {
    const s = String(body.incoming_no).trim();
    if (!s) return 'Incoming No cannot be blank';
    if (s.length > TEXT_MAX) return `Incoming No must be ${TEXT_MAX} characters or less`;
  }

  // On CREATE the incoming number is derived, never supplied -- the prefix
  // belongs to the stage the goods are going to and the number carries down the
  // chain. Anything sent is overwritten, so validating it would only produce a
  // confusing error about a value that was never going to be used.
  //
  // On a PATCH the check still earns its keep: a prefix disagreeing with the
  // stage the lot is actually at would print a misleading number.
  if (!requireAll
      && present('incoming_prefix_id') && body.incoming_prefix_id != null && body.incoming_prefix_id !== '') {
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

// The incoming number a dispatch will carry. Derived, never supplied: the prefix
// belongs to the stage the goods are going to, and the number carries down the
// chain so one suffix identifies a lot at every stage. Nothing about it is a
// choice, so the form shows it and does not offer to edit it.
//
// Returns an error string when the stage has no single active prefix, because a
// dispatch that cannot be numbered should be refused rather than written blank.
async function deriveIncomingNo(targetStage, parent) {
  // Nothing ARRIVES at Third Party -- the goods left the building. There is no
  // gate register to number them into and no tab they land on, so the pair stays
  // null and the outbound bill number is the handle instead. Looking for a
  // prefix here would refuse every sale with "No active Third Party prefix".
  if (targetStage === EXIT_STAGE) return [{ prefixId: null, incomingNo: null }, null];

  const { rows } = await db.execute({
    sql: 'SELECT id, prefix FROM stitching_prefixes WHERE stage = ? AND is_active = 1 ORDER BY id',
    args: [targetStage],
  });
  // No prefix at all is a real blocker -- a dispatch that cannot be numbered
  // should be refused rather than written blank.
  if (!rows.length) {
    return [null, `No active ${targetStage} prefix — add one in Admin → Purchase Config`];
  }
  // Several is NOT a blocker. The prefix master is deliberately many-per-stage,
  // so refusing here would break every dispatch the moment an admin adds a
  // second one. Lowest id wins: deterministic, and it is the seeded prefix that
  // an added one sits behind rather than replaces.
  return [{ prefixId: rows[0].id, incomingNo: trimOrNull(parent.incoming_no) }, null];
}

// POST /api/stitching — add a challan: part of a lot sent on to the next stage.
//
// ONE ACT, not two. Adding a challan IS sending the lot on, partly or wholly, so
// this records the whole hand-over: what left, what came back, what the stage
// cost and who checked it. A brief experiment split it into a dispatch and a
// later receipt, which added an In Transit state nobody wanted -- see the note on
// migration 072.
//
// ONE CHALLAN, SEVERAL LINES. The header -- challan no, party, rate, and the
// bill / warehouse number / checker where the destination asks for them -- is
// shared. `lines` carries one entry per grade sent, and each becomes its own
// stitching_entries row (challan_line_no 1..n) and therefore its own lot at the
// destination. A body with no `lines` is read as a single line whose fields sit
// at the top level, which is what every caller sent before lines existed.
//
// The partial part still holds: a lot of 100 can go out as 40 and then 60, each
// under its own challan, because `forwarded` sums live children and the
// parent's balance falls as each one is added.
const LINE_FIELDS = ['challan_type', 'sent_qty', 'received_qty', 'received_dozens', 'sent_dozens'];

function linesOf(body) {
  if (Array.isArray(body?.lines) && body.lines.length) return body.lines;
  const single = {};
  for (const k of LINE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body || {}, k)) single[k] = body[k];
  }
  return [single];
}

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

    // THE CALLER PICKS THE DESTINATION, validated against DESTINATIONS rather
    // than invented here. Omitting it means "the first destination".
    const allowed = destinationsFor(parent.stage);
    if (!allowed.length) {
      return res.status(400).json({
        message: parent.stage === EXIT_STAGE
          ? 'This lot was sold to a third party — it cannot be sent anywhere'
          : `This lot is at ${parent.stage} — there is nowhere further to send it`,
      });
    }
    const targetStage = trimOrNull(req.body?.target_stage) || allowed[0];
    if (!canSendTo(parent.stage, targetStage)) {
      return res.status(400).json({
        message: `A ${parent.stage} lot can only be sent to ${allowed.join(', ')}`,
      });
    }

    // Out of a lot that already counts dozens, lines are dozens. Out of
    // Processing, they are metres sent and dozens received.
    const parentDozen = countsDozens(parent.stage);

    const validationError = await validateEntryFields(req.body, {
      requireAll: true, targetStage, sourceStage: parent.stage, parentDozen, skipLine: true,
    });
    if (validationError) return res.status(400).json({ message: validationError });

    const lines = linesOf(req.body);
    for (let i = 0; i < lines.length; i += 1) {
      const lineErr = lineFieldsError(lines[i], {
        requireAll: true, parentDozen, prefix: lines.length > 1 ? `Line ${i + 1}: ` : '',
      });
      if (lineErr) return res.status(400).json({ message: lineErr });
    }

    // Every line draws on the same parent, so it is their SUM that must fit.
    const sentOf = (line) => Number(parentDozen ? line.sent_dozens : line.sent_qty);
    const totalSent = Math.round(lines.reduce((s, l) => s + sentOf(l), 0) * 100) / 100;
    const unit = parentDozen ? ' dozen' : 'm';
    if (totalSent - Number(parent.balance) > EPSILON) {
      return res.status(400).json({
        message: `Cannot send ${totalSent}${unit} — only ${parent.balance}${unit} is left on this lot`,
      });
    }

    const originReceiptId = parentSrc === 'receipt' ? parent.id : parent.origin_receipt_id;
    const partyName = trimOrNull(req.body.party_name);
    const challanNo = trimOrNull(req.body.challan_no);
    const outboundBillNo = targetStage === EXIT_STAGE ? trimOrNull(req.body.outbound_bill_no) : null;
    const panchalIncomingNo = targetStage === STOCK_STAGE
      ? trimOrNull(req.body.panchal_incoming_no) : null;
    // Who entered this, not who was picked for it. An explicit value is still
    // honoured so an import or a correction can name someone else.
    const checkedBy = req.body.checked_by != null && req.body.checked_by !== ''
      ? Number(req.body.checked_by)
      : req.user.id;

    // Checked here as well as by the unique index, so the user gets a sentence
    // rather than a raw constraint failure surfacing as a 500.
    const duplicate = await findDuplicateChallan(challanNo, partyName);
    if (duplicate) {
      return res.status(400).json({
        message: `Challan ${challanNo} has already been used for ${partyName}`,
      });
    }

    const [numbering, numberingError] = await deriveIncomingNo(targetStage, parent);
    if (numberingError) return res.status(400).json({ message: numberingError });

    // The stage being LEFT owns this rate, and it is per dozen -- every
    // destination counts dozens now.
    const processRate = numOrNull(req.body.process_rate);
    const rateUnit = processRate == null ? null : CHALLAN_RATE_UNIT;
    // Still written for the rows that read it, though nothing on the page does.
    const afterRate = req.body.after_rate != null && req.body.after_rate !== ''
      ? Number(req.body.after_rate)
      : effectiveAfterRate(parent.after_rate, processRate, null);

    const tx = await db.transaction('write');
    try {
      const ids = [];
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const challanType = trimOrNull(line.challan_type);
        // Out of Processing: metres, with what came back defaulting to what went.
        // Out of a dozen stage: no metres at all, and the dozens sent ARE the
        // dozens the next lot receives.
        const sentQty = parentDozen ? null : Number(line.sent_qty);
        const receivedQty = parentDozen ? null
          : (line.received_qty != null && line.received_qty !== '' ? Number(line.received_qty) : sentQty);
        const sentDozens = parentDozen ? Number(line.sent_dozens) : null;
        const receivedDozens = parentDozen ? sentDozens : Number(line.received_dozens);

        const { rows: inserted } = await tx.execute({
          // received_at and received_by are still written even though nothing reads
          // them to decide a status any more: sending and receiving are the same
          // moment now, so the value is true rather than vestigial.
          sql: `INSERT INTO stitching_entries
                  (stage, origin_receipt_id, parent_receipt_id, parent_entry_id, party_name,
                   challan_no, challan_line_no, challan_type, outbound_bill_no, panchal_incoming_no,
                   incoming_prefix_id, incoming_no,
                   sent_qty, received_qty, sent_dozens, received_dozens,
                   process_rate, rate_unit, after_rate, checked_by,
                   received_at, received_by, created_by, updated_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?)
                RETURNING id`,
          args: [
            targetStage, originReceiptId,
            parentSrc === 'receipt' ? parent.id : null,
            parentSrc === 'entry' ? parent.id : null,
            partyName, challanNo, i + 1, challanType, outboundBillNo, panchalIncomingNo,
            numbering.prefixId, numbering.incomingNo,
            sentQty, receivedQty, sentDozens, receivedDozens,
            processRate, rateUnit, afterRate, checkedBy,
            req.user.id, req.user.id, req.user.id,
          ],
        });
        ids.push(inserted[0].id);

        const sentText = parentDozen ? `${sentDozens} dozen` : `${sentQty}m`;
        const short = parentDozen ? 0 : Math.round((sentQty - receivedQty) * 100) / 100;
        await logAction({
          client: tx,
          userId: req.user.id,
          actionType: 'STITCHING_ENTRY_CREATE',
          description: `Challan ${challanNo}${lines.length > 1 ? ` line ${i + 1}` : ''} (${challanType}): `
            + `sent ${sentText} from ${parent.stage} to ${targetStage} for ${describeLot(parent)} at ${partyName}`
            + (parentDozen ? '' : `, ${receivedQty}m back as ${receivedDozens} dozen`)
            + (short > EPSILON ? ` with ${short}m short` : ''),
          entityType: 'stitching_entry',
          entityId: inserted[0].id,
          entityRef: challanNo,
        });
      }
      await tx.commit();
      res.status(201).json({ id: ids[0], ids, stage: targetStage });
    } catch (e) { await tx.rollback(); throw e; }
  } catch (err) { next(err); }
}

// Whether this number has already been raised to this party, anywhere. Mirrors
// the partial unique index (085, widened by line in 087) -- the readable half of
// it, so a clash comes back as a sentence rather than a raw constraint failure.
//
// (challan_no, party_name), NOT scoped to a lot. A challan number is printed
// once on a document handed to one party, so the pair is what identifies it, and
// a party's challan book does not restart per lot. The same number to a
// DIFFERENT party is fine -- two parties number from 1 independently. The lines
// of ONE challan share the pair, which is why an edit excludes its siblings.
//
// Live rows only, carried over from migration 073's rule and for its reason:
// withdrawing a challan frees its number for the corrected entry.
async function findDuplicateChallan(challanNo, partyName, excludeIds = []) {
  if (!challanNo) return null;
  const ids = excludeIds.length ? excludeIds : [-1];
  const { rows } = await db.execute({
    sql: `SELECT id FROM stitching_entries
           WHERE challan_no = ? AND party_name = ? AND deleted_at IS NULL
             AND id NOT IN (${ids.map(() => '?').join(',')})`,
    args: [challanNo, partyName, ...ids],
  });
  return rows[0] || null;
}

// The other live lines of the challan this row belongs to: same parent, same
// number, same party. Header edits are applied to all of them together, so one
// challan can never show two parties or two rates.
async function siblingLines(row) {
  if (!row.challan_no) return [];
  const { rows } = await db.execute({
    sql: `SELECT * FROM stitching_entries
           WHERE deleted_at IS NULL AND id <> ? AND challan_no = ? AND party_name = ?
             AND COALESCE(parent_receipt_id, -1) = COALESCE(?, -1)
             AND COALESCE(parent_entry_id, -1) = COALESCE(?, -1)`,
    args: [row.id, row.challan_no, row.party_name, row.parent_receipt_id, row.parent_entry_id],
  });
  return rows;
}

// POST /api/stitching/write-off — material that leaves a lot without arriving.
//
// Fabric ruined at rest, or a whole challan that never comes back. NOT a stage
// move and NOT a step backwards: the quantity leaves the lot and simply never
// turns up anywhere, which is why the row keeps its parent's stage and carries no
// challan and no incoming number.
//
// It reuses the challan's quantity column for the amount, which is what makes
// this cheap -- the parent's balance falls through the same `forwarded` sum that
// challans use. Which column depends on the parent's unit: sent_qty (metres) out
// of a Processing lot, sent_dozens out of one that counts dozens.
async function writeOff(req, res, next) {
  try {
    const parentSrc = req.body?.parent_src;
    const parentId = req.body?.parent_id;
    if (parentSrc !== 'receipt' && parentSrc !== 'entry') {
      return res.status(400).json({ message: 'parent_src must be "receipt" or "entry"' });
    }
    if (parentId == null || parentId === '') {
      return res.status(400).json({ message: 'parent_id is required' });
    }

    const reasonError = writeOffReasonError(req.body?.reason);
    if (reasonError) return res.status(400).json({ message: reasonError });
    const reason = String(req.body.reason).trim();

    const qtyErr = qtyError(req.body?.qty, 'Qty');
    if (qtyErr) return res.status(400).json({ message: qtyErr });
    const qty = Number(req.body.qty);

    const parent = await loadLot(parentSrc, Number(parentId));
    if (!parent) return res.status(404).json({ message: 'Lot not found' });
    const parentDozen = countsDozens(parent.stage);
    const unit = parentDozen ? ' dozen' : 'm';
    if (qty - Number(parent.balance) > EPSILON) {
      return res.status(400).json({
        message: `Cannot write off ${qty}${unit} — only ${parent.balance}${unit} is left on this lot`,
      });
    }

    const originReceiptId = parentSrc === 'receipt' ? parent.id : parent.origin_receipt_id;

    const tx = await db.transaction('write');
    try {
      const { rows: inserted } = await tx.execute({
        // Stage is the parent's: the material never moved. party_name likewise --
        // the column is NOT NULL, and where it was when it was lost is the truest
        // thing there is to record.
        sql: `INSERT INTO stitching_entries
                (stage, origin_receipt_id, parent_receipt_id, parent_entry_id, party_name,
                 sent_qty, received_qty, sent_dozens, received_dozens, write_off_reason,
                 received_at, received_by, created_by, updated_by)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?) RETURNING id`,
        args: [
          parent.stage, originReceiptId,
          parentSrc === 'receipt' ? parent.id : null,
          parentSrc === 'entry' ? parent.id : null,
          parent.party_name,
          parentDozen ? null : qty, parentDozen ? null : 0,
          parentDozen ? qty : null, parentDozen ? 0 : null,
          reason,
          req.user.id, req.user.id, req.user.id,
        ],
      });
      await logAction({
        client: tx,
        userId: req.user.id,
        actionType: 'STITCHING_WRITE_OFF',
        description: `Wrote off ${qty}${unit} at ${parent.stage} for ${describeLot(parent)} — ${reason}`,
        entityType: 'stitching_entry',
        entityId: inserted[0].id,
        entityRef: parent.incoming_no,
      });
      await tx.commit();
      res.status(201).json({ id: inserted[0].id, written_off: qty });
    } catch (e) { await tx.rollback(); throw e; }
  } catch (err) { next(err); }
}

// PATCH /api/stitching/:id — edit ONE line of a challan.
//
// A line's own fields (type, quantities) change on this row only. The HEADER
// fields are one per challan, so a change to any of them is applied to every
// live line of it in the same transaction, each with its own audited diff --
// otherwise one challan could end up naming two parties or two rates.
const HEADER_FIELDS = ['party_name', 'challan_no', 'process_rate', 'outbound_bill_no',
  'panchal_incoming_no', 'checked_by'];

async function update(req, res, next) {
  try {
    const { id } = req.params;
    const { rows: existing } = await db.execute({
      sql: 'SELECT * FROM stitching_entries WHERE id = ? AND deleted_at IS NULL',
      args: [id],
    });
    if (!existing.length) return res.status(404).json({ message: 'Challan not found' });
    const current = existing[0];

    const lot = await loadLot('entry', Number(id));
    const has = (k) => Object.prototype.hasOwnProperty.call(req.body || {}, k);
    // The unit this line was sent in is the unit of the lot it LEFT.
    const parentDozen = countsDozens(lot?.parent_stage);

    const validationError = await validateEntryFields(req.body, {
      targetStage: current.stage, sourceStage: lot?.parent_stage, parentDozen,
    });
    if (validationError) return res.status(400).json({ message: validationError });

    const nextSentQty = parentDozen ? current.sent_qty
      : (has('sent_qty') ? Number(req.body.sent_qty) : current.sent_qty);
    const nextReceivedQty = parentDozen ? current.received_qty
      : (has('received_qty') ? Number(req.body.received_qty)
        // Received follows Sent when only Sent was edited and the two matched,
        // the same default create() applies.
        : (has('sent_qty') && Math.abs(Number(current.received_qty) - Number(current.sent_qty)) <= EPSILON
          ? nextSentQty : current.received_qty));
    const nextSentDozens = parentDozen && has('sent_dozens') ? Number(req.body.sent_dozens) : current.sent_dozens;
    // Out of a dozen stage what was sent IS what arrived, so the two move together.
    const nextReceivedDozens = parentDozen ? nextSentDozens
      : (has('received_dozens') ? numOrNull(req.body.received_dozens) : current.received_dozens);

    // Raising what was sent can overdraw the parent. Checked in the parent's unit.
    const sentBefore = parentDozen ? current.sent_dozens : current.sent_qty;
    const sentAfter = parentDozen ? nextSentDozens : nextSentQty;
    if (Math.abs(Number(sentAfter) - Number(sentBefore)) > EPSILON) {
      const parentSrc = current.parent_receipt_id != null ? 'receipt' : 'entry';
      const parent = await loadLot(parentSrc, current.parent_receipt_id ?? current.parent_entry_id);
      // This row's own quantity is part of what the parent currently counts as
      // forwarded, so it has to be added back before comparing.
      const available = Math.round((Number(parent?.balance ?? 0) + Number(sentBefore)) * 100) / 100;
      if (Number(sentAfter) - available > EPSILON) {
        return res.status(400).json({
          message: `Cannot send ${sentAfter} — only ${available} is available on the source lot`,
        });
      }
    }
    // Lowering what this lot holds can strand what it has already sent onward.
    // Every entry counts dozens, so its holding is its dozens received.
    if (lot && nextReceivedDozens != null && nextReceivedDozens < Number(lot.forwarded) - EPSILON) {
      return res.status(400).json({
        message: `Dozens Received cannot be less than ${lot.forwarded}, already forwarded from this lot`,
      });
    }

    const siblings = await siblingLines(current);

    // The (number, party) pair is what identifies a challan, so an edit is held
    // to the same rule as the insert -- and it has to re-check when EITHER half
    // moves. This challan's own lines share the pair, so they are excluded.
    if (has('challan_no') || has('party_name')) {
      const nextChallan = has('challan_no') ? trimOrNull(req.body.challan_no) : current.challan_no;
      const nextParty = has('party_name') ? trimOrNull(req.body.party_name) : current.party_name;
      const duplicate = await findDuplicateChallan(nextChallan, nextParty,
        [Number(id), ...siblings.map(s => s.id)]);
      if (duplicate) {
        return res.status(400).json({
          message: `Challan ${nextChallan} has already been used for ${nextParty}`,
        });
      }
    }

    const nextProcessRate = has('process_rate') ? numOrNull(req.body.process_rate) : current.process_rate;
    // A rate typed on today's form is per dozen, whatever the row held before.
    const nextRateUnit = has('process_rate')
      ? (nextProcessRate == null ? null : CHALLAN_RATE_UNIT)
      : current.rate_unit;

    // The header as it will read after this edit -- applied to this row and
    // every sibling alike.
    const header = {
      party_name: has('party_name') ? trimOrNull(req.body.party_name) : current.party_name,
      challan_no: has('challan_no') ? trimOrNull(req.body.challan_no) : current.challan_no,
      outbound_bill_no: has('outbound_bill_no')
        ? trimOrNull(req.body.outbound_bill_no) : current.outbound_bill_no,
      panchal_incoming_no: has('panchal_incoming_no')
        ? trimOrNull(req.body.panchal_incoming_no) : current.panchal_incoming_no,
      process_rate: nextProcessRate,
      rate_unit: nextRateUnit,
      checked_by: has('checked_by') ? Number(req.body.checked_by) : current.checked_by,
    };
    const headerTouched = HEADER_FIELDS.some(has);

    // No bill_no. It belongs to the PO receipt, and the column here is left
    // unread rather than dropped.
    const next = {
      ...header,
      challan_type: has('challan_type') ? trimOrNull(req.body.challan_type) : current.challan_type,
      incoming_prefix_id: has('incoming_prefix_id') ? numOrNull(req.body.incoming_prefix_id) : current.incoming_prefix_id,
      incoming_no: has('incoming_no') ? trimOrNull(req.body.incoming_no) : current.incoming_no,
      sent_qty: nextSentQty,
      received_qty: nextReceivedQty,
      sent_dozens: nextSentDozens,
      received_dozens: nextReceivedDozens,
    };

    const writes = [{ row: current, next, isSelf: true }];
    if (headerTouched) {
      for (const s of siblings) writes.push({ row: s, next: { ...header }, isSelf: false });
    }

    const tx = await db.transaction('write');
    try {
      for (const w of writes) {
        const changes = diffFields(w.row, w.next, Object.keys(w.next));
        if (!changes.length) continue;
        const cols = Object.keys(w.next);
        await tx.execute({
          sql: `UPDATE stitching_entries SET ${cols.map(c => `${c} = ?`).join(', ')},
                  updated_by = ?, updated_at = datetime('now')
                WHERE id = ?`,
          args: [...cols.map(c => w.next[c]), req.user.id, w.row.id],
        });
        await logAction({
          client: tx,
          userId: req.user.id,
          actionType: 'STITCHING_ENTRY_UPDATE',
          description: w.isSelf
            ? `Updated ${current.stage} lot #${w.row.id}${lot ? ` for ${describeLot(lot)}` : ''}`
            : `Updated ${current.stage} lot #${w.row.id} with its challan (edited on line #${id})`,
          entityType: 'stitching_entry',
          entityId: Number(w.row.id),
          entityRef: w.row.incoming_no,
          changes,
        });
      }
      await tx.commit();
    } catch (e) { await tx.rollback(); throw e; }

    const [fresh] = await withLineage([outward(await loadLot('entry', Number(id)))]);
    res.json(fresh);
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
      sql: `SELECT id, stage, sent_qty, sent_dozens, incoming_no, parent_receipt_id, parent_entry_id
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
    // In the source's unit, the same one its balance is kept in.
    const took = countsDozens(parent.stage) ? entry.sent_dozens : entry.sent_qty;
    if (Number(took) - Number(parent.balance) > EPSILON) {
      return res.status(400).json({
        message: `Cannot restore — this lot took ${took}, but only ${parent.balance} is left on the source`,
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

// Which table a lot lives in. Both kinds can reach Panchal — forwarded through
// the chain, or bought directly at that stage — so close/reopen and the journey
// all take the src as part of the identity.
const TABLE_FOR_SRC = { receipt: 'outbound_po_line_receipts', entry: 'stitching_entries' };

function parseLotRef(req) {
  const { src, id } = req.params;
  if (!TABLE_FOR_SRC[src]) return [null, 'Lot type must be "receipt" or "entry"'];
  return [{ src, id: Number(id) }, null];
}

// POST /api/stitching/:id/remove — withdraw a record that should not exist.
//
// A challan entered against the wrong PO, or a write-off that turned out to be
// wrong. Both come off the same way, because both are rows hanging under a lot.
//
// A CORRECTION, not a movement. Material flows one way only, down the chain
// from Processing, and nothing here sends it back: this erases a record
// that was made wrongly. The quantity never actually left -- only the record
// said it had.
//
// No stage is named anywhere in this path, deliberately. The quantity simply
// stops counting as dispatched: `forwarded` sums only children with deleted_at
// IS NULL, so withdrawing the row restores the source lot's balance with no
// write against it at all.
//
// The reason is mandatory, because "why is there a withdrawn challan here" has
// to stay answerable long after everyone has forgotten.
async function removeChallan(req, res, next) {
  try {
    // Only a challan or a write-off can be withdrawn, and both are
    // stitching_entries rows, so the id needs no lot type beside it. An origin lot
    // is where material entered on a PO -- there is nothing of ours to withdraw.
    const ref = { id: Number(req.params.id) };

    const reasonError = revertReasonError(req.body?.reason);
    if (reasonError) return res.status(400).json({ message: reasonError });
    const reason = String(req.body.reason).trim();

    const { rows: existing } = await db.execute({
      sql: `SELECT id, stage, sent_qty, sent_dozens, incoming_no, challan_no, closed_at, write_off_reason
            FROM stitching_entries WHERE id = ? AND deleted_at IS NULL`,
      args: [ref.id],
    });
    if (!existing.length) return res.status(404).json({ message: 'Stitching entry not found' });
    const entry = existing[0];
    const isWriteOff = entry.write_off_reason != null;
    // What it took, in the unit it was taken in.
    const tookText = entry.sent_dozens != null ? `${entry.sent_dozens} dozen` : `${entry.sent_qty}m`;

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
        message: `Cannot withdraw this challan — ${children} challan(s) have been raised against what it brought in. Withdraw those first.`,
      });
    }

    if (entry.closed_at) {
      return res.status(400).json({
        message: 'This lot has been closed — reopen it before withdrawing the challan',
      });
    }

    // loadLot builds its own WHERE rather than going through buildWhere, so a
    // write-off is still reachable here even though it never appears as a lot.
    const lot = await loadLot('entry', ref.id);

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
        // Kept as REVERT rather than renamed, so existing audit history stays
        // searchable under one action type. Nothing user-facing shows it.
        actionType: 'STITCHING_ENTRY_REVERT',
        // The reason goes in the description so it outlives a later restore,
        // which clears the column. No stage is named: nothing moved anywhere,
        // the record simply should not have been made.
        description: isWriteOff
          ? `Withdrew the write-off of ${tookText} on ${describeLot(lot)} — ${reason}`
          : `Withdrew challan ${entry.challan_no || '(none)'} for ${tookText} `
            + `on ${describeLot(lot)} — ${reason}`,
        entityType: 'stitching_entry',
        entityId: ref.id,
        entityRef: entry.incoming_no,
      });
      await tx.commit();
    } catch (e) { await tx.rollback(); throw e; }

    res.json({ id: ref.id, removed: true });
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
    // Panchal, not Packing. Closing means "this stock has left the warehouse",
    // and the warehouse is where stock lives -- Packing held that role only while
    // the chain had nowhere else to end.
    if (lot.stage !== STOCK_STAGE) {
      return res.status(400).json({
        message: `Only a ${STOCK_STAGE} lot can be ${closing ? 'closed' : 'reopened'} — this one is ${lot.stage}`,
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
        description: `${closing ? 'Closed' : 'Reopened'} ${STOCK_STAGE} lot of ${lot.qty_basis} dozen `
          + `at ${lot.party_name} for ${describeLot(lot)}`,
        // Receipts are audited against their PO line, the way every other receipt
        // action in this app already is.
        entityType: ref.src === 'entry' ? 'stitching_entry' : 'outbound_po_line',
        entityId: ref.src === 'entry' ? ref.id : lot.line_id,
        entityRef: lot.incoming_no,
      });
      await tx.commit();
    } catch (e) { await tx.rollback(); throw e; }

    const [fresh] = await withLineage([outward(await loadLot(ref.src, ref.id))]);
    res.json(fresh);
  } catch (err) { next(err); }
}

const close = (req, res, next) => setClosed(req, res, next, { closing: true });
const reopen = (req, res, next) => setClosed(req, res, next, { closing: false });

// GET /api/stitching/journey/:src/:id — the full lineage of whatever lot this
// belongs to, from the PO receipt it entered on down to every leaf.
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
      sql: `SELECT e.id, e.stage, e.party_name, e.sent_qty, e.received_qty,
                   e.sent_dozens, e.received_dozens, e.challan_no, e.challan_line_no, e.challan_type,
                   e.deleted_at,
                   e.revert_reason, e.write_off_reason, e.created_at,
                   e.parent_receipt_id, e.parent_entry_id, du.name AS deleted_by_name
            FROM stitching_entries e
            LEFT JOIN users du ON du.id = e.deleted_by
            WHERE e.origin_receipt_id = ? AND e.deleted_at IS NOT NULL
            ORDER BY e.created_at, e.id`,
      args: [originId],
    });

    const liveNodes = await withLineage(rows.map(outward));
    const nodes = [
      ...liveNodes.map(r => ({ ...r, deleted: false })),
      ...removed.map(r => ({
        src: 'entry',
        id: r.id,
        lot_key: `entry:${r.id}`,
        stage: r.stage,
        party_name: r.party_name,
        sent_qty: r.sent_qty,
        received_qty: r.received_qty,
        sent_dozens: r.sent_dozens,
        received_dozens: r.received_dozens,
        challan_no: r.challan_no,
        challan_line_no: r.challan_line_no,
        challan_type: r.challan_type,
        parent_src: r.parent_receipt_id != null ? 'receipt' : 'entry',
        parent_id: r.parent_receipt_id ?? r.parent_entry_id,
        created_at: r.created_at,
        deleted: true,
        deleted_at: r.deleted_at,
        deleted_by_name: r.deleted_by_name,
        // Present only on a hop that was withdrawn as a correction. A retired row
        // without one was a plain delete — the distinction is derived from these
        // two columns rather than stored as a flag.
        revert_reason: r.revert_reason,
        // And this one says the retired row was a write-off rather than a challan,
        // so the timeline can name it for what it was.
        write_off_reason: r.write_off_reason,
        is_write_off: r.write_off_reason != null,
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
        // Only meaningful on a hop out of Processing, the one place metres are
        // sent and metres come back. Null everywhere else -- nobody sent the
        // origin, and a dozen hop receives exactly what it was sent.
        short: node.sent_qty == null || node.received_qty == null ? null
          : Math.round((Number(node.sent_qty) - Number(node.received_qty)) * 100) / 100,
        // The challan belongs to THIS hop, not to the lot it came out of. It read
        // the parent's while a challan sat on the lot being sent, and printed the
        // wrong number on every hop once challans became records of their own.
        sent_under_challan: node.challan_no ?? null,
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
    // Where the chain ENDED, which is no longer one place. Material finishes
    // either as stock in the warehouse or sold out of the business, and a chain
    // that branched can do both -- 40 dozen to Panchal and 20 to a buyer is one
    // origin lot with two endings, so these are two numbers rather than one.
    const inStock = live.filter(n => n.stage === STOCK_STAGE);
    const soldOut = live.filter(n => n.stage === EXIT_STAGE);
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
        // The PO quantity, in metres -- the one metre figure every chain starts from.
        origin_qty: root ? Number(root.received_qty) : null,
        origin_rate: root ? Number(root.po_rate) : null,
        // Both endings are counted in dozens: nothing reaches Panchal or a
        // buyer before it has been counted.
        stock_dozens: Math.round(inStock.reduce((s, n) => s + Number(n.received_dozens || 0), 0) * 100) / 100,
        sold_dozens: Math.round(soldOut.reduce((s, n) => s + Number(n.received_dozens || 0), 0) * 100) / 100,
        // No final_rate any more. It was the highest after_rate among the packed
        // leaves -- a running total that rolled every stage into one figure. Each
        // stage keeps its own rate now, so the ladder on each node IS the answer
        // and collapsing it back into a single number would throw away exactly
        // what the user asked to see.
        total_short: Math.round(live.reduce((s, n) => s + (n.short || 0), 0) * 100) / 100,
      },
    });
  } catch (err) { next(err); }
}

module.exports = {
  list, listParties, stageCounts, journey,
  create, writeOff, update, remove, restore, removeChallan, close, reopen,
  NONE_SELECTED,
};
