// Stage-wise fabric tracking: the stage chain, and everything derived from it.
//
// A "lot" is a quantity of material sitting at one processing stage. It enters
// the chain as an outbound PO receipt whose incoming-number prefix declares the
// stage it was bought at, then moves forward one stage at a time until it
// reaches Packed, where it sits as finished stock until someone closes it.
//
// Both kinds of lot (a receipt at its entry stage, a stitching_entries row at a
// later stage) answer the same questions -- what stage, how much is left, what
// does it cost -- so those answers live here rather than in either controller.
//
// Nothing in this file is stored. Status and balance are derived at read time
// for the same reason outbound PO line status and `received` are: they depend on
// rows written by other endpoints, and a stored copy would need invalidating
// across every one of them.

const STAGES = ['Gray', 'Processed', 'Stitched', 'Packed'];

// Half a paisa / half a millimetre. Metres and rates round-trip through SQLite
// REAL, so exact comparisons would call 100 and 99.99999999 different lots.
// Same value and same reasoning as RATE_EPSILON in outboundPOFlags.js.
const EPSILON = 0.005;

const STATUS = {
  PENDING: 'Pending',
  PARTIAL: 'Partial',
  FORWARDED: 'Forwarded',
  IN_STOCK: 'In Stock',
  CLOSED: 'Closed',
};

// Outstanding work: a lot still holding metre at its stage, or finished goods
// packed but not yet dispatched. Forwarded means the lot fully moved on, and
// Closed means someone confirmed it is done with -- neither needs attention.
const OPEN_STATUSES = [STATUS.PENDING, STATUS.PARTIAL, STATUS.IN_STOCK];

const isValidStage = (s) => STAGES.includes(s);

// The stage a lot moves to next, or null at the end of the chain. Forwarding
// never lets the user pick the target -- material physically goes through every
// stage in order, so the target is always a function of where the lot is now.
const nextStage = (stage) => {
  const i = STAGES.indexOf(stage);
  return i === -1 ? null : (STAGES[i + 1] || null);
};

// The stage a lot came FROM, or null at the head of the chain.
//
// Safe as a stand-in for "what stage is my parent at" only because hop creation
// is forward-only -- create() derives its target from nextStage(parent.stage)
// and never accepts a caller-supplied stage, so every entry sits exactly one
// stage after its parent. A test pins that. If a backward hop is ever allowed
// (rework, as opposed to the correction this was built for), this stops being
// equivalent and the parent's stage has to be joined instead.
const prevStage = (stage) => {
  const i = STAGES.indexOf(stage);
  return i <= 0 ? null : STAGES[i - 1];
};

// A send-back is a correction, so the reason is the whole point of the record --
// "why is there a retired hop here" has to be answerable without asking anyone.
// Hence required, unlike every other free-text field on this feature.
const REVERT_REASON_MAX = 300;

const revertReasonError = (value) => {
  const text = String(value ?? '').trim();
  if (!text) return 'A reason is required to send this back';
  if (text.length > REVERT_REASON_MAX) {
    return `Reason can be at most ${REVERT_REASON_MAX} characters`;
  }
  return null;
};

// The landed rate at a stage. after_rate is stored because the user may
// overwrite the default (to absorb wastage or rounding), so this is only the
// fallback for a row that has none -- which is what the server writes when the
// client omits it, keeping the stored value and the UI's pre-fill in step.
const effectiveAfterRate = (rate, processRate, afterRate) => {
  if (afterRate != null && afterRate !== '') return Number(afterRate);
  return Number(rate || 0) + Number(processRate || 0);
};

// How much of a lot has not yet been sent onward. `forwarded` is the sum of
// live children's sent_qty -- what LEFT this lot, not what arrived at the next
// stage, since the shortfall between the two is process loss and belongs to the
// child, not to this lot's balance.
const balanceOf = (metre, forwarded) => Number(metre || 0) - Number(forwarded || 0);

// Mirrors computeLineStatus in outboundPOs.controller.js in spirit: a small pure
// function over quantities, never a user-supplied value.
//
// Packed is the end of the chain, so balance is meaningless there -- a Packed lot
// has nowhere to forward to. It reads In Stock until someone explicitly closes
// it, which is what records that the goods left the building. Before migration
// 070 it returned Closed unconditionally, which made the status constant and
// hid packed stock from any "what is outstanding" count.
const computeStatus = ({ stage, metre, forwarded, closedAt }) => {
  if (stage === 'Packed') return closedAt ? STATUS.CLOSED : STATUS.IN_STOCK;
  const balance = balanceOf(metre, forwarded);
  if (balance <= EPSILON) return STATUS.FORWARDED;
  if (Number(forwarded || 0) > EPSILON) return STATUS.PARTIAL;
  return STATUS.PENDING;
};

// The SQL twin of computeStatus, for filtering and sorting a list by status.
// Deliberately duplicated rather than derived in JS after the fact, because
// paging has to happen in the database — filtering afterwards would return short
// pages. A parity test pins the two together, exactly as outboundPOFlags.js
// does for its flag predicates.
const statusSql = (stageCol, metreCol, forwardedCol, closedAtCol) => `CASE
  WHEN ${stageCol} = 'Packed' THEN
    CASE WHEN ${closedAtCol} IS NOT NULL THEN '${STATUS.CLOSED}' ELSE '${STATUS.IN_STOCK}' END
  WHEN ${metreCol} - ${forwardedCol} <= ${EPSILON} THEN '${STATUS.FORWARDED}'
  WHEN ${forwardedCol} > ${EPSILON} THEN '${STATUS.PARTIAL}'
  ELSE '${STATUS.PENDING}'
END`;

// Money fields accept positive decimals to two places. Zero is allowed and
// meaningful -- a Gray lot has had nothing done to it, so its process rate is
// genuinely 0 rather than missing. Returns an error string, or null when usable.
//
// The 2dp test is a round-trip rather than a regex so it accepts 12, '12.5',
// 12.50 and rejects 12.005 without caring how the number was typed. The 1e-9
// slack absorbs float representation error (0.29 * 100 is 28.999999999999996),
// which a bare !== would reject.
const moneyError = (value, label, { required = false } = {}) => {
  if (value == null || value === '') {
    return required ? `${label} is required` : null;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) return `${label} must be a number`;
  if (n < 0) return `${label} must be a number >= 0`;
  if (Math.abs(Math.round(n * 100) - n * 100) > 1e-9) {
    return `${label} can have at most 2 decimal places`;
  }
  return null;
};

// The challan a lot is dispatched under. It belongs to the lot being SENT, not
// to the hop that arrives: a lot that has just come in has not been sent
// anywhere yet, so its challan is genuinely blank until it moves on. That is
// also why a lot cannot be forwarded without one -- there is no dispatch without
// a challan to dispatch it under.
//
// Free text, deliberately. The user was asked whether "numerical" should mean
// digits-only and chose free text, the same call already made for Incoming No.
// Do not add a digits-only rule without asking again -- challan books that use a
// prefix or a slash would stop being enterable.
//
// Blank is not an error here. Clearing a challan is allowed, and the only
// consequence is that the lot stops being forwardable, which is the gate in
// create() doing its job rather than something to reject at write time.
const CHALLAN_MAX = 50;

const challanError = (value) => {
  const text = String(value ?? '').trim();
  if (text.length > CHALLAN_MAX) return `Challan No must be ${CHALLAN_MAX} characters or less`;
  return null;
};

// The gate itself, shared by the SQL-free checks on both sides so "has a
// challan" means exactly one thing.
const hasChallan = (lot) => String(lot?.challan_no ?? '').trim() !== '';

// Quantities (metres) use the same 2dp rule but must be strictly positive --
// forwarding or receiving zero metres is not a thing that happens.
const qtyError = (value, label) => {
  if (value == null || value === '') return `${label} is required`;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return `${label} must be a number > 0`;
  if (Math.abs(Math.round(n * 100) - n * 100) > 1e-9) {
    return `${label} can have at most 2 decimal places`;
  }
  return null;
};

module.exports = {
  STAGES, STATUS, OPEN_STATUSES, EPSILON, REVERT_REASON_MAX, CHALLAN_MAX,
  isValidStage, nextStage, prevStage,
  effectiveAfterRate, balanceOf, computeStatus, statusSql,
  moneyError, qtyError, revertReasonError, challanError, hasChallan,
};
