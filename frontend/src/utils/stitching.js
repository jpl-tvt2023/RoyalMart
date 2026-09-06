// Client mirror of backend/src/services/stitching.service.js. The server is
// always the authority — these copies exist so the page can label a stage, show
// the next one, and pre-fill a rate without a round trip. Keep the two in step.

export const STAGES = ['Gray', 'Processed', 'Stitched', 'Packed'];

// "All" is a VIEW, not a stage, so it is deliberately kept out of STAGES —
// nextStage/prevStage walk that list and the DB CHECK constraints mirror it, so
// a fifth member there would corrupt the chain rather than add a tab. It sits
// last: the stage tabs are the daily work, All is for following one PO through
// every stage at once.
export const ALL_TAB = 'All';
export const STAGE_TABS = [...STAGES, ALL_TAB];

// No In Transit, deliberately. Adding a challan IS sending the lot on, so no row
// ever sits between the two. Shortage is a quantity in its own column, not a
// state: sent 40 and back 38 is an ordinary lot holding 38 with 2 short.
export const STATUSES = ['Pending', 'Partial', 'Forwarded', 'In Stock', 'Closed'];

// Outstanding work: still holding stock, or packed but not yet dispatched. Twin
// of OPEN_STATUSES in the backend service, keep in step.
export const OPEN_STATUSES = ['Pending', 'Partial', 'In Stock'];

export const STATUS_COLORS = {
  Pending: 'blue',
  Partial: 'yellow',
  Forwarded: 'green',
  'In Stock': 'purple',
  Closed: 'navy',
};

export const nextStage = (stage) => {
  const i = STAGES.indexOf(stage);
  return i === -1 ? null : (STAGES[i + 1] || null);
};

// Twin of prevStage on the server. The stage a quantity came FROM — history,
// never a destination. Material only ever flows forward.
export const prevStage = (stage) => {
  const i = STAGES.indexOf(stage);
  return i <= 0 ? null : STAGES[i - 1];
};

// The suffix to offer at the next stage, so GRY123 becomes PRC123 rather than
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

// What was sent but never arrived. Null on an origin lot, which nobody sent, so
// the column renders blank rather than as a zero. Twin of the `short` expression
// in LOT_SELECT -- the server is the authority, this is for a form that has not
// submitted yet.
export const shortOf = (sentQty, receivedQty) => {
  if (sentQty == null || sentQty === '' || receivedQty == null || receivedQty === '') return null;
  return Math.round((Number(sentQty) - Number(receivedQty)) * 100) / 100;
};

export const fullIncomingNo = (row) =>
  `${row.incoming_prefix || ''}${row.incoming_no || ''}` || null;
