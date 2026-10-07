const db = require('../config/db');
const { logAction, diffFields } = require('../services/auditLog.service');
const { isValidDateString } = require('../utils/dateValidation');
const {
  FLAG_KEYS, RECEIPT_FLAG_KEYS, poFlagExists, lineFlagExists, receiptFlags, pickFlags, flagSelect,
} = require('../services/outboundPOFlags');
const { pairKey, unitMetricsByPair } = require('../services/outboundProducts.service');
const {
  moneyError, qtyError, EPSILON, isValidStage, STAGES, countsDozens, DOZEN_STAGES,
  STOCK_STAGE, EXIT_STAGE, CHALLAN_TYPES, GRADE_COLUMNS, isGradedStage, isCheckerStage,
  umKind, countsInDozens, derivedDozens, receiptHasMetres, receiptStageBlockReason,
} = require('../services/stitching.service');
const { userHasRole } = require('../services/userRoles.service');

const VALID_STATUSES = ['Open', 'Partially Received', 'Closed'];

// Deleted is a real member of the status enum (see the CHECK in migration 044),
// it is just never one deriveStatus can produce -- a PO only reaches it by being
// soft-deleted. So it is filterable like any other status, but stays out of
// VALID_STATUSES, which is the vocabulary of statuses the system derives.
const FILTERABLE_STATUSES = [...VALID_STATUSES, 'Deleted'];

// Sent by a multi-select filter whose options have all been unticked. An absent
// param already means "unconstrained", so a deliberate empty selection needs a
// marker of its own to be distinguishable from it. Deliberately NOT spelled
// 'none' -- that is a live flag key meaning "clean POs only". Twin constant in
// frontend/src/pages/OutboundPOs/OutboundPOList.jsx, keep the two in step.
const NONE_SELECTED = '__none_selected__';

// Incoming No is free text (the warehouse gate register uses ids like IN-4521),
// capped only so a paste accident cannot land an essay in the column. Twin
// constant in frontend/src/pages/OutboundPOs/OutboundPODetail.jsx, keep the two
// in step -- the client mirrors this rule to spare a round trip.
const INCOMING_NO_MAX = 50;

// A receipt's Note is a paragraph, not a handle -- room for a sentence or three
// about the delivery, capped only against a paste accident. Twin constant in
// frontend/src/pages/OutboundPOs/receiptFields.js, keep the two in step.
const NOTE_MAX = 1000;

// The agreed rate on a line, and the rate billed on a receipt against it, are
// quoted to at most 3 decimal places -- small articles (socks at 0.156 a piece)
// are priced below a paisa. Process Rate and every Stitching rate stay at the 2
// places moneyError allows. Twin in frontend/src/pages/OutboundPOs/receiptFields.js.
//
// The tolerance is absolute on the scaled value: a genuine 4th decimal leaves at
// least 0.1 after scaling by 1000, float residue is many orders smaller.
const RATE_DECIMALS = 3;
const tooManyRateDecimals = (n) =>
  Math.abs(Math.round(n * 10 ** RATE_DECIMALS) - n * 10 ** RATE_DECIMALS) > 1e-6;

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
  // EXISTS yields 0/1, so summing them sorts by how many distinct flag types
  // a PO carries -- clean POs first ascending, worst offenders first descending.
  flags:           `(${FLAG_KEYS.map(poFlagExists).join(' + ')})`,
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
    // The agreed rate may legitimately be blank -- it is what was negotiated
    // with the vendor and isn't always known when the PO is raised. Blank is
    // stored as 0 (the column is NOT NULL DEFAULT 0), and the rate-mismatch
    // flag treats 0 as "nothing to compare against".
    const rate = l.rate === '' || l.rate == null ? 0 : Number(l.rate);
    if (!Number.isFinite(rate) || rate < 0) return `Line ${i + 1}: rate must be a number >= 0`;
    if (tooManyRateDecimals(rate)) return `Line ${i + 1}: rate can have at most ${RATE_DECIMALS} decimal places`;
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

// unit_metric is COLLATE NOCASE in both masters, so metrics compare
// case-insensitively everywhere -- letting "taga" and "Taga" count as different
// would fragment the column in exactly the way migration 064 set out to prevent.
const eqMetric = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

// Resolve the unit metric a submitted line should be stored with, returning
// { metric } or { error }.
//
// Omitted or blank keeps the pre-selectable behaviour exactly: the packaging
// catalog's own UM for the triple, falling back to the item's UM ignoring
// variant so a historical line whose free-text variant never made it into the
// catalog still shows a unit. Every existing API caller therefore keeps working.
//
// A supplied metric must be one the Outbound Product List actually lists for the
// line's (category, item_name) pair, and is stored in the master's canonical
// casing. Two values are always accepted on top of that list: the catalog
// default (it is what the server itself would have chosen, and the pair may
// predate the Outbound Product List entirely) and `storedMetric`, an existing
// line's current value. Both are grandfathering, on the same principle as the
// tuple grandfathering in validateLines -- editing a master must never leave an
// existing PO unsaveable. The vendor listing mirrors this set in
// withUnitMetrics, so the dropdown offers precisely what this accepts.
// The metrics an article may be recorded in, and the catalog's own answer for
// it. Split out of resolveLineMetric because a RECEIPT now has to apply the same
// rule as the line it hangs off -- see resolveReceiptMetric below. One copy, so
// the two cannot drift into accepting different sets.
//
// `extras` are grandfathered on top of the published list, on the principle
// described at resolveLineMetric: editing a master must never leave an existing
// row unsaveable.
function allowedMetricsFor(l, umMap, metricsByPair, ...extras) {
  const exact = umMap.get(lineKey(l));
  const fallback = umMap.get(lineKey({ category: l.category, item_name: l.item_name, variant: '' }));
  const catalogDefault = exact ?? fallback ?? null;

  const allowed = [...(metricsByPair.get(pairKey(l.category, l.item_name)) || [])];
  for (const extra of [catalogDefault, ...extras]) {
    if (extra && !allowed.some(m => eqMetric(m, extra))) allowed.push(extra);
  }
  return { catalogDefault, allowed };
}

function resolveLineMetric(l, idx, umMap, metricsByPair, storedMetric) {
  const { catalogDefault, allowed } = allowedMetricsFor(l, umMap, metricsByPair, storedMetric);

  const submitted = String(l.unit_metric ?? '').trim();
  if (!submitted) return { metric: catalogDefault };

  const match = allowed.find(m => eqMetric(m, submitted));
  if (match) return { metric: match };

  const label = `${String(l.category || '').trim()} / ${String(l.item_name || '').trim()}`;
  const options = allowed.length ? ` (${allowed.join(', ')})` : '';
  return { error: `Line ${idx + 1}: "${submitted}" is not a listed unit metric for "${label}"${options}` };
}

// The unit a receipt is counted in: the one its line was ordered in. On the
// update path `row` is the receipt joined to its line, so its own stored unit
// comes first -- an older receipt keeps the unit it was taken in.
const receiptUnitOf = (row) => row?.unit_metric ?? row?.line_unit_metric ?? null;

// The unit a RECEIPT was counted in, stored on the receipt (migration 084).
//
// It is the line's, and nothing else. 084 let a receipt pick any unit the
// article was listed under, but a delivery counted in a different unit from
// the one ordered changes what its quantity means -- and with the UM deciding
// whether goods count metres or dozens, it would change which figures the
// receipt asks for too. The client asked for it to be fixed to the order. Not
// one receipt had ever used a different unit.
//
// The line's unit in any casing is accepted and stored as the line has it.
// Only a line with no unit at all (none left on prod) still resolves a
// supplied unit against the published list, so such a line stays receivable.
//
// Returns { metric } or { error }.
async function resolveReceiptMetric(submittedRaw, line) {
  const submitted = String(submittedRaw ?? '').trim();
  const fixed = receiptUnitOf(line);
  if (fixed) {
    if (!submitted || eqMetric(fixed, submitted)) return { metric: fixed };
    return { error: `A receipt is counted in the unit the line was ordered in (${fixed})` };
  }
  const [umMap, metricsByPair] = await Promise.all([catalogUnitMetrics(), unitMetricsByPair()]);
  // line_unit_metric is set on the update path, where `line` is the receipt row
  // joined to its line and unit_metric is the RECEIPT's own. Both are
  // grandfathered: a receipt must stay saveable in the unit it was taken in, and
  // in the unit its line was written in.
  const { allowed } = allowedMetricsFor(
    line, umMap, metricsByPair, line?.unit_metric, line?.line_unit_metric,
  );

  const match = allowed.find(m => eqMetric(m, submitted));
  if (match) return { metric: match };

  const options = allowed.length ? ` (${allowed.join(', ')})` : '';
  return { error: `"${submitted}" is not a listed unit metric for this article${options}` };
}

function normLine(l, idx, unitMetric) {
  return {
    id: l.id ? Number(l.id) : null,
    line_no: Number(l.line_no) || idx + 1,
    category: String(l.category).trim(),
    item_name: String(l.item_name).trim(),
    variant: String(l.variant || '').trim() || null,
    qty: Number(l.qty),
    rate: l.rate === '' || l.rate == null ? 0 : Number(l.rate) || 0,
    unit_metric: unitMetric,
  };
}

// UM is copied onto the line at write time rather than joined at read time, so
// a later catalog edit can't retroactively change what a past PO recorded.
async function catalogUnitMetrics() {
  const { rows } = await db.execute('SELECT category, item_name, variant, unit_metric FROM packaging_raw_materials');
  const map = new Map();
  for (const r of rows) {
    map.set(lineKey(r), r.unit_metric);
    const bare = lineKey({ category: r.category, item_name: r.item_name, variant: '' });
    if (!map.has(bare)) map.set(bare, r.unit_metric);
  }
  return map;
}

// Shared receipt-field rules for create and update.
//
// Billed Rate (received_rate) is the rate the vendor actually invoiced, as
// distinct from the line's agreed rate — it is mandatory, because the whole
// point of the Rate Mismatch flag is to compare the two. Checked By is no
// longer asked for and no longer a qualification -- see the note on it below.
// Bill No is mandatory — a receipt records a delivery against a
// vendor's bill, so it has one by definition. Incoming No stays optional (a
// receipt without one is flagged, not blocked). It is free text — the warehouse
// gate register uses alphanumeric ids like IN-4521 — so the only rules are that
// a supplied value is not whitespace-only and fits the column.
//
// With requireAll, absent fields are errors (create). Without it, only fields
// actually present in the body are checked (update), so a user fixing a typo in
// incoming_no isn't forced to backfill unrelated values. That is what keeps the
// receipts migration 053 synthesized (bill_no NULL, no bill was ever recorded)
// editable: the client omits bill_no entirely for those rather than sending an
// explicit null, which would count as present and trip the rule.
// Whether this line's article travels the Stitching page -- the "Goes through
// Stitching" tick on the Outbound Product List (076). The answer decides what a
// receipt asks for: a stage, the metres, the dozens, and whether
// missing_incoming_stage can fire. HOW it travels -- from Processing, or
// straight from Stitching on -- is the receipt's unit metric (umKind): goods
// bought in dozens or pieces are made up and skip Processing. Every line query
// resolves the tick through the (category, item_name, unit_metric) triple,
// since a line carries no product id.
const isStitchingLine = (line) => Number(line?.goes_to_stitching) === 1;

// The tick, read off the master through the triple. A correlated subquery so
// every line query spells it the same way.
const STITCHING_SQL = `COALESCE((SELECT op.goes_to_stitching FROM outbound_products op
                              WHERE op.category = l.category AND op.item_name = l.item_name
                                AND op.unit_metric = l.unit_metric), 0)`;

const nonBlank = (v) => (v != null && String(v).trim() !== '' ? String(v).trim() : null);

// The prefix a receipt's stage will carry. DERIVED, never chosen: the user picks
// the stage the goods arrived at and the code picks the code that prints on it.
//
// Lowest id among the stage's active prefixes, and refusing only when there are
// none -- the same rule and the same reasoning as deriveIncomingNo in
// stitching.controller.js. Prefixes are deliberately many-per-stage, so refusing
// when a stage has several would break every receipt the moment an admin adds a
// second one.
async function prefixIdForStage(stage) {
  const { rows } = await db.execute({
    sql: 'SELECT id FROM stitching_prefixes WHERE stage = ? AND is_active = 1 ORDER BY id',
    args: [stage],
  });
  if (!rows.length) {
    return [null, `No active ${stage} prefix — add one in Admin → Purchase Config`];
  }
  return [rows[0].id, null];
}

// A receipt can arrive at ANY stage. Third Party joined in 091: goods bought and
// sold straight on, without entering our stock -- like a challan into Third
// Party it takes no incoming number, carries our outbound bill number and a
// Warehouse POC who checked it over. Processing is refused per receipt rather
// than here, for goods bought in dozens or pieces (receiptStageBlockReason).
const RECEIPT_STAGES = [...STAGES];

// The receipt stages whose goods arrive GRADED -- Packing, Panchal and Third
// Party. Goods bought in there record their dozens split into Fresh, Second and
// Third, the same split a challan into those stages carries, and Dozens
// Received is their sum. Stitching is a dozen stage but not a graded one.
const RECEIPT_GRADED_STAGES = RECEIPT_STAGES.filter(isGradedStage);

// Whether the dozens on a receipt at this stage are already settled by its UM --
// a Received Qty in dozens, or in pieces (umKind, derivedDozens). Then nothing
// is asked for: the server writes received_dozens itself.
const dozensFromQty = (stitching, kind, stage) => !!stitching && countsDozens(stage) && countsInDozens(kind);

// THE STAGE, checked FIRST: it sits at the top of the receipt form because
// everything below it -- metres, dozens, grades, the Third Party hand-over --
// reshapes to match it, so it is the first answer the form asks for and the
// first error either side reports. Called before Received Qty on both paths.
// Twin of the stage check at the top of receiptFieldError on the client.
//
// The STAGE the goods arrived at, not a prefix. Nobody picks a prefix anywhere
// any more -- the stage is the fact, and the code that prints on it follows
// from it. Only stitching articles have a stage at all, and for them it is
// mandatory: material that cannot be placed on the chain cannot be tracked.
//
// `kind` is umKind of the unit this delivery is counted in. Goods bought in
// dozens or pieces have no metres, so they cannot land at Processing.
function receiptStageError(body, { requireAll, line, kind }) {
  const present = (k) => Object.prototype.hasOwnProperty.call(body || {}, k);
  const stitching = isStitchingLine(line);
  const stage = present('incoming_stage') ? nonBlank(body.incoming_stage) : null;
  if (stage) {
    if (!stitching) return 'Only articles that go through Stitching travel the Stitching stages';
    if (!RECEIPT_STAGES.includes(stage)) return `Stage must be one of ${RECEIPT_STAGES.join(', ')}`;
    const blocked = receiptStageBlockReason(stage, kind);
    if (blocked) return blocked;
  } else if (stitching && requireAll) {
    return 'Stage is required';
  } else if (stitching && !present('incoming_stage') && present('unit_metric') && line?.incoming_stage) {
    // An edit that changes only the unit: the stage the receipt already sits at
    // has to be able to take goods counted that way.
    const blocked = receiptStageBlockReason(line.incoming_stage, kind);
    if (blocked) return blocked;
  }
  return null;
}

// Whether a receipt is checked over by a Warehouse POC, as it is received.
//
// Goods that never reach the Stitching page -- packaging, barcodes, anything
// without the "Goes through Stitching" tick -- are checked here or never: no
// challan follows them. So every one of those receipts asks.
//
// A stitching line asks only where the goods land in our warehouse (Panchal)
// or leave the business (Third Party) -- the challan's CHECKER_STAGES. Bought in
// at Processing, Stitching or Packing, the goods are checked later, on the
// challan that takes them into Panchal, so the receipt carries no checker.
// Twin of receiptTakesChecker in frontend/src/pages/OutboundPOs/receiptFields.js.
const receiptTakesChecker = (line, stage) => !isStitchingLine(line) || isCheckerStage(stage);

// Checked By on a receipt that takes one, in the slot the client checks it.
// Message strings are the stitching challan's, verbatim, so both modules
// reject in identical wording.
async function checkerError(checkedBy) {
  if (checkedBy == null || String(checkedBy).trim() === '') return 'Checked By is required';
  const { rows } = await db.execute({ sql: 'SELECT id FROM users WHERE id = ?', args: [checkedBy] });
  if (!rows.length) return 'Checked By: user not found';
  if (!(await userHasRole(rows[0].id, 'Warehouse_POC'))) return 'Checked By must be a user tagged Warehouse_POC';
  return null;
}

const thirdPartyBillError = (bill) => {
  const b = nonBlank(bill);
  if (!b) return 'Outbound Bill No is required when sending to a third party';
  if (b.length > INCOMING_NO_MAX) return `Outbound Bill No must be ${INCOMING_NO_MAX} characters or less`;
  return null;
};

// The grade inputs, in CHALLAN_TYPES order: [['Fresh', 'fresh_dozens'], ...].
const GRADE_FIELDS = CHALLAN_TYPES.map(t => [t, GRADE_COLUMNS[t]]);

const gradeSum = (src) => Math.round(
  GRADE_FIELDS.reduce((s, [, col]) => s + (Number(src?.[col]) || 0), 0) * 100,
) / 100;

// What is still due on a line: ordered, less what has arrived, less what has
// been written off as never coming. Twin of pendingOf on the detail page, and
// the number the receipt form measures its Qty difference against.
const outstandingOf = (line, received) =>
  Math.max(0, Number(line.qty) - Number(received || 0) - Number(line.short || 0));

const QTY_DIFF_ACTIONS = ['write_off', 'rollover'];
const QTY_DIFF_REASON_MAX = 300;

// Which box was ticked, checked against the difference it claims to explain.
// Only one is ever offered on the form, and the server holds to the same rule:
// you cannot write off a surplus or roll over a shortfall, and a delivery that
// matches has nothing to explain. Returns [action, errorMessage].
function qtyDiffAction(body, qtyDiff) {
  const raw = body?.qty_diff_action;
  if (raw == null || raw === '') return [null, null];
  if (raw === 'write_off' && qtyDiff > -EPSILON) {
    return [null, 'Nothing to write off - this delivery is not short'];
  }
  if (raw === 'rollover' && qtyDiff < EPSILON) {
    return [null, 'Nothing to roll over - this delivery is not over'];
  }
  return [raw, null];
}

async function validateReceiptFields(body, { requireAll, line, kind = null }) {
  const present = (k) => Object.prototype.hasOwnProperty.call(body || {}, k);
  const blank = (v) => v == null || v === '';
  // bill_no is stored trimmed-or-NULL, so a whitespace-only value would slip
  // past blank() and then persist as NULL. Test it post-trim.
  const blankText = (v) => v == null || String(v).trim() === '';

  if (requireAll || present('received_rate')) {
    if (blank(body?.received_rate)) return 'Billed Rate is required';
    const rate = Number(body.received_rate);
    if (!Number.isFinite(rate) || rate < 0) return 'Billed Rate must be a number >= 0';
    if (tooManyRateDecimals(rate)) return `Billed Rate can have at most ${RATE_DECIMALS} decimal places`;
  }

  // Checked By is asked where the goods are genuinely checked over
  // (receiptTakesChecker): on every receipt that never reaches the Stitching
  // page, and on a stitching line received straight into Panchal or sold on at
  // Third Party. Validated below, after the stage's other fields.
  //
  // For a while (from 21 Sep 2026) no receipt asked, and each recorded WHO
  // ENTERED IT instead -- which read on the detail page as a checker nobody had
  // named. Those rows are left as they are and show flagged when the name is
  // not a Warehouse POC (checked_by_is_poc). A stitching receipt at Processing,
  // Stitching or Packing now carries no checker at all: its goods are checked
  // on the challan into Panchal, and the Updated column says who entered it.

  // Several tests assert on the FIRST error a body with multiple omissions
  // produces, and that ordering is the contract -- so Bill No keeps the slot it
  // has always had rather than moving up now that Checked By is optional.
  if (requireAll || present('bill_no')) {
    if (blankText(body?.bill_no)) return 'Bill No is required';
  }

  // Free text, but stored trimmed-or-NULL like bill_no, so a whitespace-only
  // value must be rejected rather than silently becoming NULL — which would
  // raise missing_incoming_no on a receipt the user believes they filled in.
  if (present('incoming_no') && !blank(body?.incoming_no)) {
    const s = String(body.incoming_no).trim();
    if (!s) return 'Incoming No cannot be blank';
    if (s.length > INCOMING_NO_MAX) return `Incoming No must be ${INCOMING_NO_MAX} characters or less`;
  }

  // Everything below is new to the Stitching work and deliberately appended
  // AFTER the existing rules: several tests assert on the FIRST error a body
  // with multiple omissions produces, and that ordering is the contract.

  // Optional, and 0 is a real answer — a free job costs nothing rather than an unknown amount.
  if (present('process_rate')) {
    const err = moneyError(body.process_rate, 'Process Rate');
    if (err) return err;
  }

  // The stage itself was checked first, by receiptStageError. What follows from
  // it starts here.
  const fabric = isStitchingLine(line);
  const bodyStage = String(body?.incoming_stage ?? '').trim();
  // The stage the receipt will sit at: the one sent, or on an edit that does not
  // restate it, the one it has -- `line` is the stored receipt on an update.
  const effStage = present('incoming_stage') ? bodyStage : String(line?.incoming_stage ?? '').trim();
  const thirdParty = fabric && effStage === EXIT_STAGE;

  // Nothing ARRIVES at Third Party -- the goods are gone -- so there is no gate
  // register to number them into, exactly as a challan into Third Party is
  // given no incoming number. Refused rather than ignored, so a number typed
  // against a sale surfaces as a question instead of vanishing.
  if (thirdParty && present('incoming_no') && !blankText(body?.incoming_no)) {
    return 'Third Party takes no Incoming No — nothing arrives there';
  }
  if (fabric && !thirdParty && requireAll && blankText(body?.incoming_no)) {
    return 'Incoming No is required';
  }

  // Fabric is bought in taga and worked in metres, and no factor converts the
  // two -- the user counts and enters it. A unit that IS metres says so itself,
  // and the server copies Received Qty across (umKind). Anything bought in
  // dozens or pieces has no metres at all. Absent on anything else, where there
  // is nothing downstream to measure.
  const metresApply = fabric && receiptHasMetres(kind);
  const metresFromQty = metresApply && kind === 'metre';
  if (present('qty_in_metres') && !blank(body?.qty_in_metres)) {
    if (!fabric) return 'Qty in metres applies to fabric articles only';
    if (!metresApply) return 'Goods bought in dozens or pieces carry no metres';
    if (!metresFromQty) {
      const err = qtyError(body.qty_in_metres, 'Qty in metres');
      if (err) return err;
    }
  } else if (metresApply && !metresFromQty && requireAll) {
    return 'Qty in metres is required';
  }

  // Fabric bought in ALREADY STITCHED, PACKED or straight into the warehouse
  // arrives as countable pieces, so it carries a dozen count exactly as a
  // challan into those stages does -- otherwise such a lot would sit on its tab
  // as the only row with no yield, which reads as missing data rather than as a
  // different kind of row.
  //
  // Keyed on the stage being RECEIVED AT, not on fabric alone: a Processing receipt
  // has no pieces to count.
  const dozenStage = fabric && countsDozens(bodyStage);
  // At a graded stage the dozens are typed per grade and Dozens Received is
  // their sum, so a missing total is not an omission there -- the grade check
  // below asks for the grades instead.
  // An edit that sends grades without restating the stage is judged against the
  // stage the receipt already has -- `line` is the stored receipt on an update.
  const gradedStage = fabric && isGradedStage(effStage);
  // A Received Qty in dozens IS the dozen count, and one in pieces is twelve to
  // the dozen -- the server writes received_dozens itself, so it is neither
  // asked for nor checked. On an update the quantity is the one sent, or the
  // one stored.
  const settled = dozensFromQty(fabric, kind, effStage)
    ? derivedDozens(present('received_qty') ? body.received_qty : line?.received_qty, kind)
    : null;
  if (present('received_dozens') && !blank(body?.received_dozens)) {
    if (!dozenStage) return `Dozens are only counted on fabric received at ${DOZEN_STAGES.join(', ')}`;
    if (settled == null) {
      const err = qtyError(body.received_dozens, 'Dozens Received');
      if (err) return err;
    }
  } else if (dozenStage && requireAll && !gradedStage && settled == null) {
    return 'Dozens Received is required';
  }

  // THE GRADES, on fabric bought in at Packing or Panchal (migration 089). Each
  // is 0 or a positive 2dp figure -- 0 is the default and means none of that
  // grade -- and together they must come to something, because a delivery of
  // no dozens is not a delivery. When the total is sent as well it has to
  // agree: the two are one fact typed twice.
  const gradesPresent = GRADE_FIELDS.some(([, col]) => present(col) && !blank(body?.[col]));
  if (gradesPresent) {
    if (!gradedStage) {
      return `Fresh, Second and Third are only recorded on fabric received at ${RECEIPT_GRADED_STAGES.join(', ')}`;
    }
    for (const [type, col] of GRADE_FIELDS) {
      const err = moneyError(body?.[col], `${type} dozens`);
      if (err) return err;
    }
    const total = gradeSum(body);
    if (total <= EPSILON) return 'Enter the dozens for at least one grade';
    // When the UM already says how many dozens arrived, the grades split that
    // figure rather than define it.
    if (settled != null && Math.abs(settled - total) > EPSILON) {
      return `Fresh + Second + Third must add up to ${settled} dozen`;
    }
    if (settled == null && present('received_dozens') && !blank(body?.received_dozens)
        && Math.abs(Number(body.received_dozens) - total) > EPSILON) {
      return 'Fresh + Second + Third must add up to Dozens Received';
    }
  } else if (gradedStage && requireAll) {
    return 'Enter the dozens for at least one grade';
  }

  // THIRD PARTY's hand-over (091), the same two questions a challan into Third
  // Party asks: OUR outbound bill number, the only handle on goods that have
  // left, and the Warehouse POC who checked them over. PANCHAL asks the second
  // of the two, as a challan into the warehouse does -- goods arriving in our
  // stock. A real qualification at both, in the same slot.
  // An edit moving a receipt INTO either stage is held to them by
  // updateReceipt, which knows what is already stored.
  if (thirdParty) {
    if (requireAll || present('outbound_bill_no')) {
      const err = thirdPartyBillError(body?.outbound_bill_no);
      if (err) return err;
    }
  } else if (present('outbound_bill_no') && !blankText(body?.outbound_bill_no)) {
    return 'Outbound Bill No applies only to goods sold to a third party';
  }
  // The checker, on any receipt that takes one -- the same slot for a
  // stitching line and for goods that never reach the Stitching page. Where a
  // receipt takes none it is not stored, so one sent is not judged.
  if (receiptTakesChecker(line, effStage) && (requireAll || present('checked_by'))) {
    const err = await checkerError(body?.checked_by);
    if (err) return err;
  }

  // What to do about a delivery that does not match what was outstanding. The
  // action says which box was ticked, the reason says why, and neither is
  // inferable from the other -- so a ticked box without a reason is refused.
  if (present('qty_diff_action') && !blank(body?.qty_diff_action)) {
    if (!QTY_DIFF_ACTIONS.includes(body.qty_diff_action)) {
      return `Qty difference action must be one of ${QTY_DIFF_ACTIONS.join(', ')}`;
    }
    if (blankText(body?.qty_diff_reason)) {
      return body.qty_diff_action === 'write_off'
        ? 'A reason is required to write off the shortfall'
        : 'A reason is required to roll over the excess';
    }
    if (String(body.qty_diff_reason).trim().length > QTY_DIFF_REASON_MAX) {
      return `Reason can be at most ${QTY_DIFF_REASON_MAX} characters`;
    }
  }

  // The unit the delivery was counted in: always the line's (see
  // resolveReceiptMetric). The form shows it and sends nothing. A caller that
  // does send one must send the line's. Last in this function for the reason
  // given above -- the first error a multi-omission body returns is the contract.
  if (present('unit_metric') && !blank(body?.unit_metric)) {
    const { error } = await resolveReceiptMetric(body.unit_metric, line);
    if (error) return error;
  }

  // Optional free text, appended after everything else for the ordering reason
  // given above. Stored trimmed-or-NULL, so only the length can be wrong.
  if (present('note') && !blank(body?.note)) {
    if (String(body.note).trim().length > NOTE_MAX) return `Note must be ${NOTE_MAX} characters or less`;
  }

  return null;
}

// A prefix with no number behind it names a stage for goods that have no gate
// reference at all — it would print as a bare "GRY" and put a phantom lot on the
// Stitching page, so it is refused.
//
// The reverse is deliberately ALLOWED. A number with no prefix is exactly the
// state every receipt written before this feature is in, and the state a user is
// in when they have the gate slip but the stage has not been decided. Forcing a
// prefix here would make it impossible to record what is actually known, and
// would leave the missing_incoming_stage flag with nothing to ever report. That
// flag is the mechanism instead: the gap stays visible on the PO and the lot
// simply does not appear on a Stitching tab until someone assigns a stage.
//
// Checked separately from validateReceiptFields because a PATCH may supply
// either half alone, and the answer then depends on what is already stored.
function incomingPairError(nextIncomingNo, nextPrefixId) {
  const hasNo = nextIncomingNo != null && String(nextIncomingNo).trim() !== '';
  const hasPrefix = nextPrefixId != null && nextPrefixId !== '';
  if (hasPrefix && !hasNo) return 'Incoming No is required when a stage is selected';
  return null;
}

// Metres already forwarded out of a receipt onto the Stitching page. A receipt
// cannot be deleted or shrunk below this, or the lots downstream of it would be
// accounting for material their source no longer claims to have.
async function forwardedFromReceipt(receiptId, client) {
  const executor = client || db;
  const { rows } = await executor.execute({
    sql: `SELECT COALESCE(SUM(sent_qty), 0) AS sent, COALESCE(SUM(sent_dozens), 0) AS sent_dozens,
                 COUNT(*) AS n
          FROM stitching_entries
          WHERE parent_receipt_id = ? AND deleted_at IS NULL`,
    args: [receiptId],
  });
  // Metres out of a receipt at Processing, dozens out of one bought in at a
  // stage that already counts dozens -- whichever applies, the other is 0.
  return {
    sent: Number(rows[0]?.sent) || 0,
    sentDozens: Number(rows[0]?.sent_dozens) || 0,
    count: Number(rows[0]?.n) || 0,
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
                 l.unit_metric,
                 l.updated_by, l.updated_at, l.deleted_by, l.deleted_at,
                 ub.name AS updated_by_name,
                 COALESCE((SELECT SUM(r.received_qty) FROM outbound_po_line_receipts r
                           WHERE r.line_id = l.id AND r.deleted_at IS NULL), 0) AS received,
                 -- Whether this article travels the Stitching page. Resolved by
                 -- the (category, item_name, unit_metric) triple because a line
                 -- carries those denormalised and no product id -- the same
                 -- lookup migration 057 used to backfill unit_metric.
                 ${STITCHING_SQL} AS goes_to_stitching,
                 ${flagSelect(lineFlagExists, RECEIPT_FLAG_KEYS)}
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
                   r.checked_by, r.incoming_no, r.unit_metric, r.qty_in_metres, r.received_dozens,
                   r.qty_diff_action, r.qty_diff_reason,
                   r.process_rate, r.incoming_prefix_id,
                   r.fresh_dozens, r.second_dozens, r.third_dozens, r.note,
                   r.stage_party_name, r.stage_rate,
                   -- A receipt booked straight into Third Party has no prefix,
                   -- and its stage is held on the receipt itself (091).
                   sp.prefix AS incoming_prefix, COALESCE(sp.stage, r.direct_stage) AS incoming_stage,
                   r.direct_stage, r.outbound_bill_no,
                   r.created_by, r.created_at, r.updated_by, r.updated_at, r.deleted_by, r.deleted_at,
                   cb.name AS created_by_name, ub.name AS updated_by_name, kb.name AS checked_by_name,
                   -- Whether the stored checker is a Warehouse POC. Receipts
                   -- entered from 21 Sep 2026 until Checked By was asked again
                   -- hold whoever typed them, and the detail page flags those.
                   EXISTS (SELECT 1 FROM user_roles ur
                            WHERE ur.user_id = r.checked_by AND ur.role = 'Warehouse_POC') AS checked_by_is_poc,
                   -- Lots already forwarded onto the Stitching page. The detail
                   -- page uses it to explain why delete/edit is refused, rather
                   -- than only surfacing the error after a round trip.
                   (SELECT COUNT(*) FROM stitching_entries se
                     WHERE se.parent_receipt_id = r.id AND se.deleted_at IS NULL) AS stitching_children
            FROM outbound_po_line_receipts r
            LEFT JOIN users cb ON cb.id = r.created_by
            LEFT JOIN users ub ON ub.id = r.updated_by
            LEFT JOIN users kb ON kb.id = r.checked_by
            LEFT JOIN stitching_prefixes sp ON sp.id = r.incoming_prefix_id
            WHERE r.line_id IN (${rPlaceholders}) ${receiptDeletedClause}
            ORDER BY r.line_id, r.created_at, r.id`,
      args: lineIds,
    });
    const receiptsByLine = new Map();
    for (const r of receipts) {
      if (!receiptsByLine.has(r.line_id)) receiptsByLine.set(r.line_id, []);
      receiptsByLine.get(r.line_id).push(r);
    }
    for (const l of rows) {
      l.receipts = receiptsByLine.get(l.id) || [];
      // Per-receipt flags let the detail page point at the exact offending row,
      // rather than only saying the line as a whole has a problem.
      for (const r of l.receipts) r.flags = receiptFlags(r, l);
    }
  }

  const byPo = new Map();
  for (const l of rows) {
    l.flags = pickFlags(l);
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
         COALESCE(ub.name, cb.name) AS updated_by_name,
         ${flagSelect(poFlagExists)}
  FROM outbound_pos p
  JOIN outbound_vendors v ON v.id = p.vendor_id
  LEFT JOIN companies c ON c.id = p.company_id
  LEFT JOIN users ab ON ab.id = p.approved_by
  LEFT JOIN users cb ON cb.id = p.created_by
  LEFT JOIN users ub ON ub.id = p.updated_by
`;

function withOrderNo(row) {
  return { ...row, order_no: padOrderNo(row.id), flags: pickFlags(row) };
}

// Shared by list() and getItemNameCounts() so the two can never disagree
// about which POs match the active filters. Returns { where, args } with `p`
// as the outbound_pos alias. Set excludeItemName to omit the item_name
// condition even if present in query — used by getItemNameCounts so every
// tab's badge reflects "how many POs would show given today's OTHER filters".
function buildListWhere(query, { excludeItemName = false } = {}) {
  const { order_no, vendor_id, status, po_date_from, po_date_to, flag, item_name, incoming_no, bill_no } = query;
  const conditions = [];
  const args = [];
  if (order_no) {
    const n = parseInt(String(order_no).replace(/^0+/, ''), 10);
    if (Number.isInteger(n)) { conditions.push('p.id = ?'); args.push(n); }
    else { conditions.push('0'); }
  }
  // Substring match, exactly like bill_no below. Incoming No is alphanumeric
  // now, so an exact match would make the box useless for anyone who remembers
  // the digits but not the prefix -- and the two adjacent search boxes behaving
  // differently is its own surprise.
  if (incoming_no) {
    conditions.push(`EXISTS (SELECT 1 FROM outbound_po_lines l JOIN outbound_po_line_receipts r ON r.line_id = l.id
      WHERE l.po_id = p.id AND l.deleted_at IS NULL AND r.deleted_at IS NULL AND r.incoming_no LIKE ?)`);
    args.push(`%${incoming_no}%`);
  }
  if (bill_no) {
    conditions.push(`EXISTS (SELECT 1 FROM outbound_po_lines l JOIN outbound_po_line_receipts r ON r.line_id = l.id
      WHERE l.po_id = p.id AND l.deleted_at IS NULL AND r.deleted_at IS NULL AND r.bill_no LIKE ?)`);
    args.push(`%${bill_no}%`);
  }
  if (vendor_id) { conditions.push('p.vendor_id = ?'); args.push(vendor_id); }
  if (po_date_from) { conditions.push('p.po_date >= ?'); args.push(po_date_from); }
  if (po_date_to)   { conditions.push('p.po_date <= ?'); args.push(po_date_to); }
  // ?status=Open,Partially Received,Deleted -- Deleted filters like any other
  // value rather than being a special whole-string mode, so it can be combined
  // with live statuses. Absent or unrecognised input still means "every live
  // PO", which is the sane default for a caller that says nothing -- whereas an
  // explicitly emptied selection means no PO qualifies.
  if (status === NONE_SELECTED) {
    conditions.push('0');
  } else {
    const statusValues = String(status || '').split(',').map(s => s.trim())
      .filter(s => FILTERABLE_STATUSES.includes(s));
    if (statusValues.length) {
      conditions.push(`p.status IN (${statusValues.map(() => '?').join(',')})`);
      args.push(...statusValues);
    } else {
      conditions.push("p.status <> 'Deleted'");
    }
  }

  // ?flag=rate_mismatch,missing_incoming_no -- OR-combined, so a PO matches
  // if it carries ANY of the selected flags. The pseudo-key `none` matches
  // only clean POs. This goes into the shared `where` below so the page query
  // and the COUNT query can never disagree about the total.
  if (flag === NONE_SELECTED) {
    conditions.push('0');
  } else {
    const flagSel = String(flag || '').split(',').map(s => s.trim()).filter(Boolean);
    const flagClauses = [];
    if (flagSel.includes('none')) {
      flagClauses.push(`(${FLAG_KEYS.map(k => `NOT ${poFlagExists(k)}`).join(' AND ')})`);
    }
    for (const k of flagSel.filter(k => FLAG_KEYS.includes(k))) flagClauses.push(poFlagExists(k));
    if (flagClauses.length) conditions.push(`(${flagClauses.join(' OR ')})`);
  }

  // Item-name tab filter: a PO matches if ANY of its (active) lines has this
  // item_name -- filters which POs appear, not which lines render within them.
  if (item_name && !excludeItemName) {
    conditions.push('EXISTS (SELECT 1 FROM outbound_po_lines l WHERE l.po_id = p.id AND l.deleted_at IS NULL AND l.item_name = ?)');
    args.push(item_name);
  }

  return { where: conditions.length ? 'WHERE ' + conditions.join(' AND ') : '', args };
}

async function list(req, res, next) {
  try {
    const { where, args } = buildListWhere(req.query);

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

// Per-item-name PO count for the item-name tab badges, scoped by every OTHER
// active filter (item_name itself excluded, so each tab shows "how many POs
// would show if I picked this tab"). A PO with two different-item_name lines
// counts once per matching item_name group, so the 'All' total is computed
// separately (COUNT DISTINCT with no GROUP BY) rather than summed across
// groups, which would overcount multi-item POs.
async function getItemNameCounts(req, res, next) {
  try {
    const { where, args } = buildListWhere(req.query, { excludeItemName: true });
    const [{ rows: groupRows }, { rows: allRows }] = await Promise.all([
      db.execute({
        sql: `SELECT l.item_name, COUNT(DISTINCT p.id) AS n
              FROM outbound_pos p
              JOIN outbound_po_lines l ON l.po_id = p.id AND l.deleted_at IS NULL
              ${where}
              GROUP BY l.item_name`,
        args,
      }),
      db.execute({
        sql: `SELECT COUNT(DISTINCT p.id) AS n FROM outbound_pos p ${where}`,
        args,
      }),
    ]);
    const counts = {};
    for (const r of groupRows) counts[r.item_name] = Number(r.n) || 0;
    counts.All = Number(allRows[0]?.n) || 0;
    res.json({ counts });
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

    if (po_date && !isValidDateString(po_date)) {
      return res.status(400).json({ message: 'Invalid po_date format (expected YYYY-MM-DD)' });
    }
    if (approval_date && !isValidDateString(approval_date)) {
      return res.status(400).json({ message: 'Invalid approval_date format (expected YYYY-MM-DD)' });
    }

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
    const [umMap, metricsByPair] = await Promise.all([catalogUnitMetrics(), unitMetricsByPair()]);
    const normLines = [];
    for (let i = 0; i < lines.length; i++) {
      // No stored metric to grandfather: every line here is brand new.
      const { metric, error: metricError } = resolveLineMetric(lines[i], i, umMap, metricsByPair, null);
      if (metricError) return res.status(400).json({ message: metricError });
      normLines.push(normLine(lines[i], i, metric));
    }
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
          sql: `INSERT INTO outbound_po_lines (po_id, line_no, category, item_name, variant, qty, rate, unit_metric, updated_by, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now')) RETURNING id`,
          args: [poId, l.line_no, l.category, l.item_name, l.variant, l.qty, l.rate, l.unit_metric, req.user.id],
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
    if (has('po_date') && req.body.po_date && !isValidDateString(req.body.po_date)) {
      return res.status(400).json({ message: 'Invalid po_date format (expected YYYY-MM-DD)' });
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
      if (!isValidDateString(suppliedDate)) {
        return res.status(400).json({ message: 'Invalid approval_date format (expected YYYY-MM-DD)' });
      }
      nextApprovalDate = suppliedDate;
    } else if (has('approval_date') && req.body.approval_date) {
      if (!isValidDateString(req.body.approval_date)) {
        return res.status(400).json({ message: 'Invalid approval_date format (expected YYYY-MM-DD)' });
      }
      nextApprovalDate = req.body.approval_date;
    }

    let nextLines = null;
    let existingLines = [];
    if (has('lines')) {
      const mappingSet = await vendorMappingSet(current.vendor_id);
      // unit_metric is selected because diffFields compares before/after below
      // (an absent `before` value would read as undefined vs a real value and
      // emit a spurious change on every single save) and because the metric lock
      // compares against it. short and received come along for that lock too:
      // computeLineStatus needs all three to say whether a line is still Open.
      const { rows: activeLines } = await db.execute({
        sql: `SELECT l.id, l.line_no, l.category, l.item_name, l.variant, l.qty, l.rate, l.unit_metric, l.short,
                     COALESCE((SELECT SUM(r.received_qty) FROM outbound_po_line_receipts r
                               WHERE r.line_id = l.id AND r.deleted_at IS NULL), 0) AS received
              FROM outbound_po_lines l WHERE l.po_id = ? AND l.deleted_at IS NULL`,
        args: [id],
      });
      existingLines = activeLines;
      const grandfathered = new Set(existingLines.map(lineKey));
      const linesError = validateLines(req.body.lines, mappingSet, grandfathered);
      if (linesError) return res.status(400).json({ message: linesError });
      const [umMap, metricsByPair] = await Promise.all([catalogUnitMetrics(), unitMetricsByPair()]);
      const beforeById = new Map(existingLines.map(el => [el.id, el]));
      nextLines = [];
      for (let i = 0; i < req.body.lines.length; i++) {
        const l = req.body.lines[i];
        const before = l.id ? beforeById.get(Number(l.id)) : null;
        const { metric, error: metricError } = resolveLineMetric(l, i, umMap, metricsByPair, before?.unit_metric);
        if (metricError) return res.status(400).json({ message: metricError });
        // Once a line stops being Open, its received quantities and the rates it
        // was billed at were all recorded against the metric in force at the
        // time. Re-labelling it now would silently reinterpret every one of them,
        // so the metric is fixed from that point on.
        if (before && computeLineStatus(before) !== 'Open' && !eqMetric(metric, before.unit_metric)) {
          return res.status(400).json({
            message: `Line ${i + 1}: unit metric cannot be changed once the line has been received against`,
          });
        }
        nextLines.push(normLine(l, i, metric));
      }
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
            const lineChanges = diffFields(before, l, ['line_no', 'category', 'item_name', 'variant', 'qty', 'rate', 'unit_metric']);
            if (lineChanges.length) {
              await tx.execute({
                sql: `UPDATE outbound_po_lines SET line_no=?, category=?, item_name=?, variant=?, qty=?, rate=?, unit_metric=?,
                        updated_by=?, updated_at=datetime('now') WHERE id=?`,
                args: [l.line_no, l.category, l.item_name, l.variant, l.qty, l.rate, l.unit_metric, req.user.id, l.id],
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
              sql: `INSERT INTO outbound_po_lines (po_id, line_no, category, item_name, variant, qty, rate, unit_metric, updated_by, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now')) RETURNING id`,
              args: [id, l.line_no, l.category, l.item_name, l.variant, l.qty, l.rate, l.unit_metric, req.user.id],
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

    // qty/short/rate and the received sum come back in one hit so the
    // closed-line gate below needs no extra round trip.
    const { rows: lineRows } = await db.execute({
      sql: `SELECT l.id, l.category, l.item_name, l.variant, l.qty, l.short, l.rate, l.unit_metric,
                   COALESCE((SELECT SUM(r.received_qty) FROM outbound_po_line_receipts r
                             WHERE r.line_id = l.id AND r.deleted_at IS NULL), 0) AS received,
                   ${STITCHING_SQL} AS goes_to_stitching
            FROM outbound_po_lines l
            WHERE l.id = ? AND l.po_id = ? AND l.deleted_at IS NULL`,
      args: [lineId, id],
    });
    if (!lineRows.length) return res.status(404).json({ message: 'Line not found' });
    const line = lineRows[0];

    // A fully accounted-for line takes no further receipts. If a vendor really
    // over-delivers, raise the line's qty on the detail page first.
    if (computeLineStatus(line) === 'Closed') {
      return res.status(400).json({ message: 'This line is already Closed — no further receipts can be added' });
    }

    // What the delivery's unit means (umKind) -- the line's, which is the only
    // unit a receipt can be counted in. Decides which figures are still to be asked.
    const kind = umKind(line.unit_metric ?? nonBlank(req.body?.unit_metric));

    // The stage first: the form asks for it first, because everything below
    // reshapes to it.
    const stageError = receiptStageError(req.body, { requireAll: true, line, kind });
    if (stageError) return res.status(400).json({ message: stageError });

    const receivedQty = Number(req.body?.received_qty);
    if (!Number.isFinite(receivedQty) || receivedQty <= 0) {
      return res.status(400).json({ message: 'Received Qty must be a number > 0' });
    }
    const validationError = await validateReceiptFields(req.body, { requireAll: true, line, kind });
    if (validationError) return res.status(400).json({ message: validationError });
    const receivedRate = Number(req.body.received_rate);
    const billNo = req.body?.bill_no != null ? (String(req.body.bill_no).trim() || null) : null;
    // The client sends a stage, never a prefix. Resolving it here is what keeps
    // the prefix master a display concern rather than something a user picks.
    const incomingStage = req.body?.incoming_stage != null
      ? (String(req.body.incoming_stage).trim() || null) : null;
    // The Warehouse POC who checked the goods over, at Panchal or Third Party
    // only -- validation has already held it to the role there. Anywhere else a
    // receipt carries no checker.
    const checkedBy = receiptTakesChecker(line, incomingStage) ? Number(req.body.checked_by) : null;
    // Third Party has no prefix -- nothing arrives there to number -- so the
    // stage is held on the receipt itself, and there is no incoming number.
    const thirdParty = isStitchingLine(line) && incomingStage === EXIT_STAGE;
    const directStage = thirdParty ? EXIT_STAGE : null;
    const outboundBillNo = thirdParty ? nonBlank(req.body?.outbound_bill_no) : null;
    const incomingNo = thirdParty ? null : nonBlank(req.body?.incoming_no);
    let prefixId = null;
    if (incomingStage && !thirdParty) {
      const [resolved, prefixError] = await prefixIdForStage(incomingStage);
      if (prefixError) return res.status(400).json({ message: prefixError });
      prefixId = resolved;
    }

    const pairError = incomingPairError(incomingNo, prefixId);
    if (pairError) return res.status(400).json({ message: pairError });

    // The unit this delivery was counted in: the line's (resolveReceiptMetric).
    let unitMetric = line.unit_metric;
    if (req.body?.unit_metric != null && String(req.body.unit_metric).trim() !== '') {
      const { metric, error: metricError } = await resolveReceiptMetric(req.body.unit_metric, line);
      if (metricError) return res.status(400).json({ message: metricError });
      unitMetric = metric;
    }

    // Fabric only, and the number a Processing lot counts in. A UM that IS
    // metres says so itself, so Received Qty is copied across. Anything bought
    // in dozens or pieces has none.
    const metresApply = isStitchingLine(line) && receiptHasMetres(kind);
    const qtyInMetres = !metresApply ? null
      : kind === 'metre' ? receivedQty
        : req.body?.qty_in_metres != null && req.body.qty_in_metres !== ''
          ? Number(req.body.qty_in_metres) : null;

    // At a graded stage (Packing, Panchal, Third Party) the dozens arrive split
    // by grade and the total is their sum. Everywhere else the three stay 0.
    const graded = isStitchingLine(line) && isGradedStage(incomingStage);
    const grades = Object.fromEntries(GRADE_FIELDS.map(([, col]) => [
      col, graded ? Number(req.body?.[col]) || 0 : 0,
    ]));

    // Only for goods bought in already stitched or later -- the stages where
    // there are pieces to count. A UM in dozens or pieces already settles the
    // figure: validation held the grades to it.
    const settledDozens = dozensFromQty(isStitchingLine(line), kind, incomingStage)
      ? derivedDozens(receivedQty, kind) : null;
    const receivedDozens = settledDozens != null ? settledDozens
      : graded ? gradeSum(grades)
        : isStitchingLine(line) && countsDozens(incomingStage)
          && req.body?.received_dozens != null && req.body.received_dozens !== ''
          ? Number(req.body.received_dozens) : null;
    const note = req.body?.note != null ? (String(req.body.note).trim() || null) : null;

    // Against what was still due when this delivery was entered, not against the
    // whole order -- a part delivery is not a shortfall.
    const outstanding = outstandingOf(line, line.received);
    const qtyDiff = Math.round((receivedQty - outstanding) * 100) / 100;
    const [diffAction, diffError] = qtyDiffAction(req.body, qtyDiff);
    if (diffError) return res.status(400).json({ message: diffError });
    const diffReason = diffAction ? String(req.body.qty_diff_reason).trim() : null;

    const processRate = req.body?.process_rate != null && req.body.process_rate !== ''
      ? Number(req.body.process_rate) : null;

    // Panchal is the end of the chain. Goods bought straight into it have
    // nothing left to happen to them, so the receipt is closed as it is saved
    // rather than sitting In Stock until someone remembers to close it.
    const closesOnSave = isStitchingLine(line) && incomingStage === STOCK_STAGE;

    const tx = await db.transaction('write');
    try {
      const { rows: inserted } = await tx.execute({
        sql: `INSERT INTO outbound_po_line_receipts (line_id, received_qty, received_rate, bill_no, checked_by, incoming_no,
                process_rate, incoming_prefix_id, direct_stage, outbound_bill_no,
                unit_metric, qty_in_metres, received_dozens,
                fresh_dozens, second_dozens, third_dozens, note,
                qty_diff_action, qty_diff_reason, closed_at, closed_by, created_by, updated_by)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                      ${closesOnSave ? "datetime('now')" : 'NULL'}, ?, ?, ?) RETURNING id`,
        args: [lineId, receivedQty, receivedRate, billNo, checkedBy, incomingNo,
          processRate, prefixId, directStage, outboundBillNo,
          unitMetric, qtyInMetres, receivedDozens,
          grades.fresh_dozens, grades.second_dozens, grades.third_dozens, note,
          diffAction, diffReason, closesOnSave ? req.user.id : null, req.user.id, req.user.id],
      });

      // Writing off a shortfall fills in the LINE's short, which is what closes
      // it. A second column recording the same idea would let a line look open
      // when everyone knows it is finished, so there is only ever one number for
      // "never coming" -- the reason for it lives on the receipt above.
      if (diffAction === 'write_off') {
        const shortfall = Math.round((outstanding - receivedQty) * 100) / 100;
        await tx.execute({
          sql: `UPDATE outbound_po_lines SET short = COALESCE(short, 0) + ?,
                  updated_by = ?, updated_at = datetime('now') WHERE id = ?`,
          args: [shortfall, req.user.id, lineId],
        });
        await logAction({
          client: tx,
          userId: req.user.id,
          actionType: 'OUTBOUND_PO_LINE_SHORT_UPDATE',
          description: `Wrote off ${shortfall} short on line "${line.category} - ${line.item_name}`
            + `${line.variant ? ` - ${line.variant}` : ''}" (PO ${padOrderNo(id)}) — ${diffReason}`,
          entityType: 'outbound_po_line',
          entityId: Number(lineId),
        });
      }
      await logAction({
        client: tx,
        userId: req.user.id,
        actionType: 'OUTBOUND_PO_LINE_RECEIPT_CREATE',
        description: `Added receipt of ${receivedQty} on line "${line.category} - ${line.item_name}${line.variant ? ` - ${line.variant}` : ''}"${billNo ? `, bill #${billNo}` : ''} @ ${receivedRate}${incomingNo != null ? `, incoming #${incomingNo}` : ''} (PO ${padOrderNo(id)})`
          + (closesOnSave ? `, received straight into ${STOCK_STAGE} and closed` : '')
          + (thirdParty ? `, sold straight on to a third party against outbound bill #${outboundBillNo}` : ''),
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
      sql: `SELECT r.id, r.received_qty, r.received_rate, r.bill_no, r.checked_by, r.incoming_no,
                   r.process_rate, r.incoming_prefix_id, r.qty_in_metres,
                   r.received_dozens, r.unit_metric, r.closed_at,
                   r.fresh_dozens, r.second_dozens, r.third_dozens, r.note,
                   r.stage_party_name, r.stage_rate, r.direct_stage, r.outbound_bill_no,
                   COALESCE(sp.stage, r.direct_stage) AS incoming_stage,
                   l.category, l.item_name, l.variant, l.unit_metric AS line_unit_metric,
                   ${STITCHING_SQL} AS goes_to_stitching
            FROM outbound_po_line_receipts r
            JOIN outbound_po_lines l ON l.id = r.line_id
            LEFT JOIN stitching_prefixes sp ON sp.id = r.incoming_prefix_id
            WHERE r.id = ? AND r.line_id = ? AND l.po_id = ? AND r.deleted_at IS NULL`,
      args: [receiptId, lineId, id],
    });
    if (!receiptRows.length) return res.status(404).json({ message: 'Receipt not found' });
    const receipt = receiptRows[0];

    const has = (k) => Object.prototype.hasOwnProperty.call(req.body || {}, k);

    // The unit this delivery is counted in, as a kind (umKind). It cannot change
    // on an edit (resolveReceiptMetric), so it is the receipt's own.
    const kind = umKind(receiptUnitOf(receipt) ?? nonBlank(req.body.unit_metric));

    const stageError = receiptStageError(req.body, { requireAll: false, line: receipt, kind });
    if (stageError) return res.status(400).json({ message: stageError });

    let nextQty = receipt.received_qty;
    if (has('received_qty')) {
      nextQty = Number(req.body.received_qty);
      if (!Number.isFinite(nextQty) || nextQty <= 0) return res.status(400).json({ message: 'Received Qty must be a number > 0' });
    }
    const validationError = await validateReceiptFields(req.body, { requireAll: false, line: receipt, kind });
    if (validationError) return res.status(400).json({ message: validationError });

    const nextRate = has('received_rate') ? Number(req.body.received_rate) : receipt.received_rate;
    let nextBillNo = receipt.bill_no;
    if (has('bill_no')) {
      nextBillNo = req.body.bill_no != null ? (String(req.body.bill_no).trim() || null) : null;
    }
    let nextIncomingNo = receipt.incoming_no;
    if (has('incoming_no')) {
      nextIncomingNo = req.body.incoming_no != null
        ? (String(req.body.incoming_no).trim() || null) : null;
    }
    // Nothing arrives at Third Party, so a receipt there carries no number.
    if (isStitchingLine(receipt) && (has('incoming_stage') ? nonBlank(req.body.incoming_stage) : receipt.incoming_stage) === EXIT_STAGE) {
      nextIncomingNo = null;
    }
    let nextProcessRate = receipt.process_rate;
    if (has('process_rate')) {
      nextProcessRate = req.body.process_rate != null && req.body.process_rate !== ''
        ? Number(req.body.process_rate) : null;
    }
    // A stage in, a prefix out -- the client never names a prefix. Third Party
    // has none: its stage is held on the receipt (direct_stage, 091).
    let nextPrefixId = receipt.incoming_prefix_id;
    let nextDirectStage = receipt.direct_stage ?? null;
    if (has('incoming_stage')) {
      const stage = nonBlank(req.body.incoming_stage);
      if (!stage) {
        nextPrefixId = null;
        nextDirectStage = null;
      } else if (stage === EXIT_STAGE && isStitchingLine(receipt)) {
        nextPrefixId = null;
        nextDirectStage = EXIT_STAGE;
      } else {
        const [resolved, prefixError] = await prefixIdForStage(stage);
        if (prefixError) return res.status(400).json({ message: prefixError });
        nextPrefixId = resolved;
        nextDirectStage = null;
      }
    }

    // The stage the receipt will be at once this edit lands.
    const nextStage = has('incoming_stage')
      ? (String(req.body.incoming_stage ?? '').trim() || null)
      : receipt.incoming_stage;
    const stageMoved = (nextStage || null) !== (receipt.incoming_stage || null);
    const nextThirdParty = isStitchingLine(receipt) && nextStage === EXIT_STAGE;

    // The checker, on a receipt that takes one (receiptTakesChecker) -- a
    // non-stitching line's stage never moves, so it simply keeps what it has
    // unless one is sent. One already stored carries over only from a stage that
    // asked for it: a receipt moving in from Stitching may hold whoever typed
    // it, and that is not a checker. Moving OUT of Panchal / Third Party clears
    // it. Any other edit leaves what is stored alone.
    const nextTakesChecker = receiptTakesChecker(receipt, nextStage);
    const nextCheckedBy = nextTakesChecker
      ? (has('checked_by') ? Number(req.body.checked_by)
        : receiptTakesChecker(receipt, receipt.incoming_stage) ? receipt.checked_by : null)
      : (stageMoved ? null : receipt.checked_by);

    // Metres: a unit that IS metres copies Received Qty across, and goods bought
    // in dozens or pieces carry none -- whatever is stored.
    let nextQtyInMetres = receipt.qty_in_metres;
    if (has('qty_in_metres')) {
      nextQtyInMetres = req.body.qty_in_metres != null && req.body.qty_in_metres !== ''
        ? Number(req.body.qty_in_metres) : null;
    }
    const metresFromQty = isStitchingLine(receipt) && receiptHasMetres(kind) && kind === 'metre';
    if (metresFromQty) nextQtyInMetres = nextQty;
    else if (isStitchingLine(receipt) && !receiptHasMetres(kind)) nextQtyInMetres = null;

    let nextReceivedDozens = receipt.received_dozens;
    if (has('received_dozens')) {
      nextReceivedDozens = req.body.received_dozens != null && req.body.received_dozens !== ''
        ? Number(req.body.received_dozens) : null;
    }
    // Dozens a UM in dozens or pieces already settles follow the quantity on
    // every edit, so a corrected Received Qty corrects the lot.
    const settledDozens = dozensFromQty(isStitchingLine(receipt), kind, nextStage) ? derivedDozens(nextQty, kind) : null;
    if (settledDozens != null) nextReceivedDozens = settledDozens;

    // Our outbound bill belongs to a sale, and only to a sale: it goes when the
    // receipt leaves Third Party. The incoming number goes the other way --
    // nothing arrives at Third Party, so a receipt moved there keeps none.
    let nextOutboundBillNo = receipt.outbound_bill_no ?? null;
    if (has('outbound_bill_no')) nextOutboundBillNo = nonBlank(req.body.outbound_bill_no);
    if (!nextThirdParty) nextOutboundBillNo = null;

    // Grades exist only at a graded stage. Sent ones replace the stored three and
    // make Dozens Received their sum. A receipt moved OFF a graded stage drops
    // them -- a Fresh count means nothing at Stitching.
    const gradesSent = GRADE_FIELDS.some(([, col]) => has(col));
    const nextGraded = isStitchingLine(receipt) && isGradedStage(nextStage);
    const nextGrades = Object.fromEntries(GRADE_FIELDS.map(([, col]) => [
      col,
      !nextGraded ? 0 : gradesSent ? Number(req.body[col]) || 0 : Number(receipt[col]) || 0,
    ]));
    if (nextGraded && gradesSent && settledDozens == null) nextReceivedDozens = gradeSum(nextGrades);
    // Grades split a UM-settled figure rather than define it, so an edit that
    // moves that figure -- a new quantity, unit or stage -- has to leave the
    // grades adding up to it. Sent grades were held to it by validation.
    if (nextGraded && settledDozens != null && !gradesSent
        && (has('received_qty') || has('unit_metric') || stageMoved)
        && Math.abs(gradeSum(nextGrades) - settledDozens) > EPSILON) {
      return res.status(400).json({ message: `Fresh + Second + Third must add up to ${settledDozens} dozen` });
    }

    let nextNote = receipt.note;
    if (has('note')) nextNote = req.body.note != null ? (String(req.body.note).trim() || null) : null;

    // The lot's Stage Party and Rate belong to the stage it sits at, so a receipt
    // moved to another stage starts without them. Only reachable while nothing
    // has been sent out of it -- the stage guard below refuses the move
    // otherwise -- so no challan is left disagreeing with its lot.
    const nextStageParty = stageMoved ? null : receipt.stage_party_name;
    const nextStageRate = stageMoved ? null : receipt.stage_rate;

    const pairError = incomingPairError(nextIncomingNo, nextPrefixId);
    if (pairError) return res.status(400).json({ message: pairError });

    // The receipt keeps the unit it was taken in -- an older row that predates
    // migration 084 and still has none takes its line's, which is what the read
    // path shows anyway. An edit naming a different unit is refused.
    let nextUnitMetric = receiptUnitOf(receipt);
    if (has('unit_metric') && nonBlank(req.body.unit_metric)) {
      const { metric, error: metricError } = await resolveReceiptMetric(req.body.unit_metric, receipt);
      if (metricError) return res.status(400).json({ message: metricError });
      nextUnitMetric = metric;
    }

    // Guards against re-cutting the ground under lots already forwarded on the
    // Stitching page. Both are only reachable once something has been forwarded,
    // so an ordinary receipt edit never sees them.
    //
    // Keyed on the STAGE moving, not the prefix: swapping to another prefix for
    // the same stage is harmless -- the lot stays on the tab it is on, and its
    // children stay valid -- and a Third Party receipt has no prefix at all.
    if (has('incoming_stage') && stageMoved) {
      const { count } = await forwardedFromReceipt(receiptId);
      if (count > 0) {
        return res.status(400).json({
          message: `Cannot change the receipt's stage — ${count} lot(s) have already been forwarded from it on the Stitching page. `
            + 'Remove those first.',
        });
      }
    }
    // Moved INTO Third Party or Panchal: the hand-over fields have to be there,
    // from this edit or already stored -- the same rule a new receipt meets.
    if (nextThirdParty && stageMoved) {
      const billErr = thirdPartyBillError(nextOutboundBillNo);
      if (billErr) return res.status(400).json({ message: billErr });
    }
    if (nextTakesChecker && stageMoved) {
      const checkErr = await checkerError(nextCheckedBy);
      if (checkErr) return res.status(400).json({ message: checkErr });
    }
    // What the Stitching page counts is the METRES for fabric, so that is what
    // cannot be cut below the lots already sent out of it. received_qty is taga
    // and keeps its own guard for the legacy rows that predate the split. A
    // unit in metres moves the metres with the quantity, so it is guarded too.
    if ((has('qty_in_metres') || (metresFromQty && has('received_qty'))) && isStitchingLine(receipt)) {
      const { sent } = await forwardedFromReceipt(receiptId);
      if (sent - Number(nextQtyInMetres || 0) > EPSILON) {
        return res.status(400).json({
          message: `Qty in metres cannot be less than ${sent}, already forwarded from this receipt on the Stitching page`,
        });
      }
    }
    // A receipt bought in at a dozen stage is drawn on in dozens, so that is
    // what cannot be cut below what its challans already took.
    if ((has('received_dozens') || (gradesSent && nextGraded)
        || (settledDozens != null && (has('received_qty') || has('unit_metric'))))
        && isStitchingLine(receipt) && countsDozens(receipt.incoming_stage)) {
      const { sentDozens } = await forwardedFromReceipt(receiptId);
      if (sentDozens - Number(nextReceivedDozens || 0) > EPSILON) {
        return res.status(400).json({
          message: `Dozens Received cannot be less than ${sentDozens}, already forwarded from this receipt on the Stitching page`,
        });
      }
    }
    if (has('received_qty') && !isStitchingLine(receipt)) {
      const { sent } = await forwardedFromReceipt(receiptId);
      if (sent - nextQty > EPSILON) {
        return res.status(400).json({
          message: `Received Qty cannot be less than ${sent}, already forwarded from this receipt on the Stitching page`,
        });
      }
    }

    // challan_no is deliberately absent from every receipt path here. The column
    // still exists and is still written -- but by the Stitching page, which owns
    // it now. A challan records material being SENT OUT to a processor, which is
    // a stitching concept. What a PO receipt needs is the vendor's Bill No, and
    // that is already here.
    //
    // qty_diff_action and qty_diff_reason are deliberately absent too. They
    // record a decision taken about ONE delivery at the moment it was entered,
    // and re-deciding it on an edit would have to unwind whatever the line's
    // short already absorbed. Corrections go through the inline Short cell on
    // the line, which is what updateLineShort is for.
    const RECEIPT_FIELDS = ['received_qty', 'received_rate', 'bill_no', 'checked_by', 'incoming_no',
      'process_rate', 'incoming_prefix_id', 'unit_metric', 'qty_in_metres',
      'received_dozens', 'fresh_dozens', 'second_dozens', 'third_dozens', 'note',
      'stage_party_name', 'stage_rate', 'direct_stage', 'outbound_bill_no'];
    const changes = diffFields(receipt, {
      received_qty: nextQty, received_rate: nextRate, bill_no: nextBillNo,
      checked_by: nextCheckedBy, incoming_no: nextIncomingNo,
      process_rate: nextProcessRate,
      incoming_prefix_id: nextPrefixId, unit_metric: nextUnitMetric,
      qty_in_metres: nextQtyInMetres,
      received_dozens: nextReceivedDozens,
      ...nextGrades,
      note: nextNote,
      stage_party_name: nextStageParty, stage_rate: nextStageRate,
      direct_stage: nextDirectStage, outbound_bill_no: nextOutboundBillNo,
    }, RECEIPT_FIELDS);

    // Moving a receipt INTO Panchal closes it, the same as saving one there does.
    // Moving it OUT reopens it -- closed only means something at Panchal, and a
    // stale close left on a Processing lot would read as a contradiction. A
    // receipt that stays at Panchal keeps whatever close state it has, so a
    // deliberate reopen on the Stitching page is not undone by an unrelated edit.
    let closeChange = null;
    if (has('incoming_stage') && (stageMoved || nextPrefixId !== receipt.incoming_prefix_id) && isStitchingLine(receipt)) {
      const wasPanchal = receipt.incoming_stage === STOCK_STAGE;
      const isPanchal = nextStage === STOCK_STAGE;
      if (isPanchal && !wasPanchal) closeChange = 'close';
      else if (wasPanchal && !isPanchal && receipt.closed_at) closeChange = 'reopen';
    }

    const tx = await db.transaction('write');
    try {
      if (closeChange) {
        await tx.execute({
          sql: closeChange === 'close'
            ? `UPDATE outbound_po_line_receipts SET closed_at = datetime('now'), closed_by = ? WHERE id = ?`
            : 'UPDATE outbound_po_line_receipts SET closed_at = NULL, closed_by = NULL WHERE id = ?',
          args: closeChange === 'close' ? [req.user.id, receiptId] : [receiptId],
        });
        await logAction({
          client: tx,
          userId: req.user.id,
          actionType: closeChange === 'close' ? 'STITCHING_LOT_CLOSE' : 'STITCHING_LOT_REOPEN',
          description: closeChange === 'close'
            ? `Receipt moved into ${STOCK_STAGE} and closed (PO ${padOrderNo(id)})`
            : `Receipt moved out of ${STOCK_STAGE} and reopened (PO ${padOrderNo(id)})`,
          entityType: 'outbound_po_line',
          entityId: Number(lineId),
        });
      }
      if (changes.length) {
        await tx.execute({
          sql: `UPDATE outbound_po_line_receipts SET received_qty = ?, received_rate = ?, bill_no = ?,
                  checked_by = ?, incoming_no = ?, process_rate = ?,
                  incoming_prefix_id = ?, unit_metric = ?, qty_in_metres = ?, received_dozens = ?,
                  fresh_dozens = ?, second_dozens = ?, third_dozens = ?, note = ?,
                  stage_party_name = ?, stage_rate = ?, direct_stage = ?, outbound_bill_no = ?,
                  updated_by = ?, updated_at = datetime('now') WHERE id = ?`,
          args: [nextQty, nextRate, nextBillNo, nextCheckedBy, nextIncomingNo,
            nextProcessRate, nextPrefixId, nextUnitMetric,
            nextQtyInMetres, nextReceivedDozens,
            nextGrades.fresh_dozens, nextGrades.second_dozens, nextGrades.third_dozens, nextNote,
            nextStageParty, nextStageRate, nextDirectStage, nextOutboundBillNo,
            req.user.id, receiptId],
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

    // Deleting the source of a forwarded lot would orphan every stage
    // downstream of it. Same guard idiom as referencingVendorNames() in
    // packagingRawMaterials.controller.js — refuse, and name what is in the way.
    const { count: forwardedCount } = await forwardedFromReceipt(receiptId);
    if (forwardedCount > 0) {
      return res.status(400).json({
        message: `Cannot delete this receipt — ${forwardedCount} lot(s) have been forwarded from it on the Stitching page. `
          + 'Remove those first.',
      });
    }

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
  list, getItemNameCounts, getOne, create, update, remove, restore,
  updateLineShort, createReceipt, updateReceipt, deleteReceipt, restoreReceipt,
};
