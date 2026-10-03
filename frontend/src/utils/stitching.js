// Client mirror of backend/src/services/stitching.service.js. The server is
// always the authority — these copies exist so the page can label a stage, show
// the next one, and pre-fill a rate without a round trip. Keep the two in step.

// Chain order, matching the server. Named for the work done at each stage
// (migration 087), and with no Gray: a receipt starts at the first stage that
// actually works on the fabric. Panchal is our warehouse and is where stock
// actually sits. Third Party is not a processing stage at all — it is the exit,
// where goods leave the business against an outbound bill.
export const STAGES = ['Processing', 'Stitching', 'Packing', 'Panchal', 'Third Party'];

// Twin of DESTINATIONS on the server: where a lot at each stage may be sent.
// The destination chooser renders straight from this, so a stage with one
// destination shows one tile and a terminal stage shows none.
export const DESTINATIONS = {
  Processing: ['Stitching', 'Packing', 'Panchal', 'Third Party'],
  Stitching: ['Packing', 'Panchal', 'Third Party'],
  Packing: ['Panchal', 'Third Party'],
  Panchal: [],
  'Third Party': [],
};

export const EXIT_STAGE = 'Third Party';
export const STOCK_STAGE = 'Panchal';

// What each destination tile says under its name, so the person picking does not
// have to know the chain by heart.
export const DESTINATION_HINTS = {
  Stitching: 'next stage',
  Packing: 'next stage',
  Panchal: 'our warehouse',
  'Third Party': 'sold out, needs a bill no',
};

// What a unit metric means, read off its name. Twin of umKind on the server --
// keep the lists identical, or the form asks for a figure the server fills in
// (or the reverse). dozen: Received Qty is the dozens. piece: Received Qty / 12
// is the dozens. metre: Received Qty is the metres. Goods bought in dozens or
// pieces are made up: no metres, and they skip Processing.
export const DOZEN_UMS = ['dozen', 'dozens', 'dzn', 'dz', 'doz'];
export const METRE_UMS = ['metre', 'metres', 'meter', 'meters', 'mtr', 'mtrs', 'm'];
export const PIECE_UMS = ['pcs', 'pc', 'piece', 'pieces'];
export const PIECES_PER_DOZEN = 12;

export const umKind = (um) => {
  const key = String(um ?? '').toLowerCase().replace(/[\s.]/g, '');
  if (!key) return null;
  if (DOZEN_UMS.includes(key)) return 'dozen';
  if (METRE_UMS.includes(key)) return 'metre';
  if (PIECE_UMS.includes(key)) return 'piece';
  return null;
};

// Twin of countsInDozens on the server: made-up goods, counted in dozens.
export const countsInDozens = (kind) => kind === 'dozen' || kind === 'piece';

// Twin of derivedDozens on the server: the dozens a UM already settles, or null.
export const derivedDozens = (receivedQty, kind) => {
  if (receivedQty == null || receivedQty === '') return null;
  const n = Number(receivedQty);
  if (!Number.isFinite(n)) return null;
  if (kind === 'dozen') return Math.round(n * 100) / 100;
  if (kind === 'piece') return Math.round((n / PIECES_PER_DOZEN) * 100) / 100;
  return null;
};

// Twin of receiptHasMetres on the server.
export const receiptHasMetres = (kind) => !countsInDozens(kind);

// Twin of receiptStageBlockReason on the server, message text included -- the
// form shows it beside the disabled Processing option.
export const receiptStageBlockReason = (stage, kind) => {
  if (stage !== 'Processing') return null;
  if (countsInDozens(kind)) return 'Processing counts metres — goods bought in dozens or pieces cannot be received there';
  return null;
};

// "All" is a VIEW, not a stage, so it is deliberately kept out of STAGES — the
// DB CHECK constraints mirror that list, so a member here that is not a real
// stage would corrupt the chain rather than add a tab. It sits last: the stage
// tabs are the daily work, All is for following one PO through every stage.
export const ALL_TAB = 'All';
export const STAGE_TABS = [...STAGES, ALL_TAB];

// No In Transit, deliberately. Adding a challan IS sending the lot on, so no row
// ever sits between the two. Shortage is a quantity in its own column, not a
// state: sent 40 and back 38 is an ordinary lot holding 38 with 2 short.
export const STATUSES = ['Pending', 'Partial', 'Forwarded', 'In Stock', 'Closed', 'Sold'];

// The statuses a lot on this tab can actually have, which is all the tab's
// status filter offers. Follows computeStatus in the backend service: the
// warehouse is only ever In Stock or Closed, a sale is only ever Sold, and every
// other stage only ever Pending, Partial or Forwarded. The All view spans them
// all. Client-only -- the server accepts any list, so there is no twin to keep.
export const statusesFor = (stage) => {
  if (stage === STOCK_STAGE) return ['In Stock', 'Closed'];
  if (stage === EXIT_STAGE) return ['Sold'];
  if (stage === ALL_TAB) return STATUSES;
  return ['Pending', 'Partial', 'Forwarded'];
};

// Outstanding work: still holding stock, or packed but not yet dispatched. Twin
// of OPEN_STATUSES in the backend service, keep in step.
export const OPEN_STATUSES = ['Pending', 'Partial', 'In Stock'];

// A multi-select filter with everything unticked means "match nothing", which
// an absent param cannot say — omitting status already means "unconstrained".
// Twin of NONE_SELECTED in backend/src/controllers/stitching.controller.js,
// keep the two in step.
export const NONE_SELECTED = '__none_selected__';

// Twin of PARTY_USE_STAGES in the backend service and of the CHECK on
// stitching_party_uses (migration 090). EVERY stage: a tag means "works at this
// stage" -- the Stage Party on a lot there, and the sender on any challan out of
// it -- so a processing house is tagged Processing and a buyer Third Party.
export const PARTY_USE_STAGES = [...STAGES];

// The kinds of goods a challan may carry. Twin of CHALLAN_TYPES on the server.
// Nothing is pre-selected in the form: a grade the user did not choose is worse
// than one they have to pick.
export const CHALLAN_TYPES = ['Fresh', 'Second', 'Third'];

// Twin of GRADED_STAGES on the server (migration 089): the stages goods arrive
// at as ONE lot per challan, its dozens split into Fresh, Second and Third side
// by side. The split is what arrived -- balance and status still run on the
// total. A PO receipt booked into any of the three records the same split.
export const GRADED_STAGES = ['Packing', 'Panchal', 'Third Party'];

export const isGradedStage = (stage) => GRADED_STAGES.includes(stage);

// Twin of GRADE_COLUMNS on the server: which column holds which grade.
export const GRADE_COLUMNS = { Fresh: 'fresh_dozens', Second: 'second_dozens', Third: 'third_dozens' };

// The grades a row carries, in CHALLAN_TYPES order, keeping only those above 0:
// [['Fresh', 10], ['Second', 5]]. What a graded lot shows in place of a type.
export const gradesOf = (row) => CHALLAN_TYPES
  .map(t => [t, Number(row?.[GRADE_COLUMNS[t]]) || 0])
  .filter(([, n]) => n > 0);

export const STATUS_COLORS = {
  Pending: 'blue',
  Partial: 'yellow',
  Forwarded: 'green',
  'In Stock': 'purple',
  Closed: 'navy',
  Sold: 'orange',
};

// The stages that count DOZENS and nothing else. Twin of DOZEN_STAGES on the
// server. Processing is the last stage in metres: a challan leaving it records
// metres sent and dozens received, which is where fabric becomes pieces. From
// Stitching on, a lot's quantity, its balance and every challan out of it are
// dozens.
export const DOZEN_STAGES = ['Stitching', 'Packing', 'Panchal', 'Third Party'];

export const countsDozens = (stage) => DOZEN_STAGES.includes(stage);

// The unit a lot at this stage is counted in, and its balance kept in.
export const balanceUnitFor = (stage) => (countsDozens(stage) ? 'dz' : 'm');

// The unit a stage's own rate is quoted in, and so the unit of the rate on any
// challan LEAVING it: the Processing rate is per metre, and from Stitching on
// every rate is per dozen. Twin of stageRateUnit on the server, which replaced
// 087's CHALLAN_RATE_UNIT (every rate per dozen).
export const stageRateUnit = (stage) => (countsDozens(stage) ? 'dozen' : 'metre');

// "/m" or "/dz" -- the suffix a stage's rate is shown with.
export const stageRateSuffix = (stage) => (stageRateUnit(stage) === 'metre' ? '/m' : '/dz');

// "Processing rate", "Stitching rate" — the label a challan's rate carries,
// named for the stage the goods are leaving.
export const stageRateLabel = (sourceStage) => `${sourceStage} rate`;

// Yield: how many metres it took to make a dozen. Never stored — derived here
// and on the server from the two numbers that are, to two places. Null rather
// than 0 or Infinity when either half is missing, so the field renders blank
// instead of a number that means nothing.
export const metresPerDozen = (receivedQty, receivedDozens) => {
  // Checked BEFORE the cast, because Number(null) and Number('') are both 0 —
  // which is finite, and would turn an empty field into a yield of 0 rather
  // than a blank while the user is still typing.
  if (receivedQty == null || receivedQty === '' || receivedDozens == null || receivedDozens === '') {
    return null;
  }
  const qty = Number(receivedQty);
  const dz = Number(receivedDozens);
  if (!Number.isFinite(qty) || !Number.isFinite(dz) || dz <= 0) return null;
  return Math.round((qty / dz) * 100) / 100;
};

export const destinationsFor = (stage) => DESTINATIONS[stage] || [];

// Twin of RATE_STAGES on the server: the stages that SEND, and so keep a Rate of
// their own -- the "<stage> rate" on every challan out of the lot, one value.
// Panchal and Third Party send nothing; their Rate is still the worked-out total.
export const RATE_STAGES = STAGES.filter(s => destinationsFor(s).length > 0);

export const isRateStage = (stage) => RATE_STAGES.includes(stage);

export const canSendTo = (fromStage, toStage) => destinationsFor(fromStage).includes(toStage);

// The first destination, which is what the chooser pre-selects. No longer "the
// next stage" in any binding sense — the user picks, and the server validates
// the pick. Kept so the form opens with the usual answer selected.
export const nextStage = (stage) => destinationsFor(stage)[0] || null;

// prevStage is gone. It described a strictly linear chain, and the chain
// branches now: a lot at Packing may have come from Processing or from
// Stitching, so "the stage before this one" has no single answer.
//
// So is rateLadderStages. The page no longer shows a column per stage rate —
// it shows one per-dozen total, which the server builds (rateTotal in the
// service) and whose breakdown the tooltip spells out.

// The suffix to offer at the next stage, so PRC123 becomes STC123 rather than
// being retyped. Only the number travels — the prefix belongs to the stage the
// lot is moving to, not the one it is leaving.
export const carriedIncomingNo = (lot) => String(lot?.incoming_no ?? '').trim();

// The prefix to pre-select for a stage, but only when the choice is unambiguous.
// Prefixes are admin-managed and deliberately many-per-stage, so picking one of
// several would be a guess the user then has to notice and undo — worse than
// leaving it empty.
export const soleActivePrefix = (prefixes, stage) => {
  const matches = (prefixes || []).filter(p => p.stage === stage && p.is_active);
  return matches.length === 1 ? matches[0] : null;
};

// Half a paisa / half a millimetre. Twin of EPSILON in the backend service.
export const EPSILON = 0.005;

// Mirrors moneyError/qtyError on the server, including the message text, so the
// user sees the same wording whichever side rejects the value. The 2dp check is
// a round-trip rather than a regex so it accepts 12, '12.5' and 12.50 alike, and
// the 1e-9 slack absorbs float error (0.29 * 100 is 28.999999999999996).
const has2dp = (n) => Math.abs(Math.round(n * 100) - n * 100) <= 1e-9;

export function moneyError(value, label, { required = false } = {}) {
  if (value == null || value === '') return required ? `${label} is required` : null;
  const n = Number(value);
  if (!Number.isFinite(n)) return `${label} must be a number`;
  if (n < 0) return `${label} must be a number >= 0`;
  if (!has2dp(n)) return `${label} can have at most 2 decimal places`;
  return null;
}

export function qtyError(value, label) {
  if (value == null || value === '') return `${label} is required`;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return `${label} must be a number > 0`;
  if (!has2dp(n)) return `${label} can have at most 2 decimal places`;
  return null;
}

// Twins of challanError / revertReasonError on the server, including the message
// text, so the user sees the same wording whichever side rejects the value.
//
// Challan is FREE TEXT by explicit decision -- the user was asked whether
// "numerical" should mean digits-only and chose free text, as with Incoming No.
// Do not add a digits-only rule without asking again. Blank is checked by the
// dispatch form, which requires one, rather than here.
export const CHALLAN_MAX = 50;

export const challanError = (value) => {
  const text = String(value ?? '').trim();
  if (text.length > CHALLAN_MAX) return `Challan No must be ${CHALLAN_MAX} characters or less`;
  return null;
};

export const REVERT_REASON_MAX = 300;

export const revertReasonError = (value) => {
  const text = String(value ?? '').trim();
  if (!text) return 'A reason is required to withdraw this challan';
  if (text.length > REVERT_REASON_MAX) return `Reason can be at most ${REVERT_REASON_MAX} characters`;
  return null;
};

// Writing material off destroys a quantity on paper, so "where did 60 go" has to
// stay answerable. Separate from the withdrawal reason because the two say
// different things: material gone, versus a row that should never have existed.
export const WRITE_OFF_REASON_MAX = 300;

export const writeOffReasonError = (value) => {
  const text = String(value ?? '').trim();
  if (!text) return 'A reason is required to write material off';
  if (text.length > WRITE_OFF_REASON_MAX) return `Reason can be at most ${WRITE_OFF_REASON_MAX} characters`;
  return null;
};

// After Rate defaults to carried-in rate plus this stage's process rate, and
// stays on that default until the user types over it.
export const defaultAfterRate = (rate, processRate) => {
  const n = Number(rate || 0) + Number(processRate || 0);
  return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : '';
};

// Trailing zeros are noise in a table; 62.5 reads better than 62.50.
export const fmtNum = (v) => (v == null || v === '' ? '—' : String(Math.round(Number(v) * 100) / 100));

// A quantity with its unit attached. The unit comes from the PO line, because
// this page carries fabric measured in metres AND packaging bought by the piece
// -- printing "5 m" against 5 corrugated boxes is simply false. Falls back to a
// bare number rather than inventing a unit.
export const fmtQty = (value, unit) => {
  const n = fmtNum(value);
  if (n === '—') return n;
  return unit ? `${n} ${unit}` : n;
};

export const fullIncomingNo = (row) =>
  `${row.incoming_prefix || ''}${row.incoming_no || ''}` || null;
