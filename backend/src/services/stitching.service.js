// Stage-wise fabric tracking: the stage chain, and everything derived from it.
//
// A "lot" is a quantity of material sitting at one processing stage. It enters
// the chain as an outbound PO receipt whose incoming-number prefix declares the
// stage it was bought at, then moves forward on challans until it reaches
// Panchal, where it sits as finished stock, or leaves the business at Third Party.
//
// Both kinds of lot (a receipt at its entry stage, a stitching_entries row at a
// later stage) answer the same questions -- what stage, how much is left, what
// does it cost -- so those answers live here rather than in either controller.
//
// Nothing in this file is stored. Status and balance are derived at read time
// for the same reason outbound PO line status and `received` are: they depend on
// rows written by other endpoints, and a stored copy would need invalidating
// across every one of them.

// Listed in CHAIN ORDER, which STAGE_ORDER_SQL in the controller is generated
// from -- a plain alphabetical sort would read Packing, Panchal, Processing,
// Stitching and put the end of the chain second.
//
// Named for the WORK being done at the stage, not its result -- migration 087
// renamed Processed/Stitched/Packed. There is no Gray any more: fabric is never
// booked in raw, so a receipt starts at the first stage that actually works on it.
//
// Panchal is our own warehouse and is where stock actually sits. Third Party is
// not a processing stage at all: it is the exit, where goods leave the business
// against an outbound bill.
const STAGES = ['Processing', 'Stitching', 'Packing', 'Panchal', 'Third Party'];

// Where a lot at each stage may be sent. THE single source of truth: the
// destination chooser renders from it, create() validates the caller's target
// against it, can_forward is derived from it, and the party master's use tags
// are its distinct values.
//
// The chain used to be a strict line, which is why the target was always
// nextStage(parent.stage) and the user never picked one. It branches now --
// finished goods can skip a stage, go to the warehouse, or be sold straight out
// -- and a single next-stage function cannot express that.
//
// Two stages lead nowhere, for different reasons. Panchal is the warehouse: what
// arrives there is stock, and it leaves by being closed, not forwarded. Third
// Party is the exit: the goods are gone. Selling stock out of Panchal later is a
// real possibility the user considered and declined for now -- when they want
// it, it is 'Third Party' added to the Panchal array and nothing else.
const DESTINATIONS = {
  Processing: ['Stitching', 'Packing', 'Panchal', 'Third Party'],
  Stitching: ['Packing', 'Panchal', 'Third Party'],
  Packing: ['Panchal', 'Third Party'],
  Panchal: [],
  'Third Party': [],
};

// The stage material physically LEAVES the business at. It takes no incoming
// number (nothing arrives), carries an outbound bill number instead, and can
// never be forwarded out of.
const EXIT_STAGE = 'Third Party';

// The stage finished goods sit at as stock, and the only one where closing means
// anything. Packing held this role until Panchal existed -- migration 070 gave it
// an In Stock status precisely because the chain had nowhere else to end.
const STOCK_STAGE = 'Panchal';

// Half a paisa, half a millimetre, half a piece. Quantities and rates round-trip
// through SQLite REAL, so exact comparisons would call 100 and 99.99999999
// different lots.
// Same value and same reasoning as RATE_EPSILON in outboundPOFlags.js.
const EPSILON = 0.005;

const STATUS = {
  PENDING: 'Pending',
  PARTIAL: 'Partial',
  FORWARDED: 'Forwarded',
  IN_STOCK: 'In Stock',
  CLOSED: 'Closed',
  // Terminal. The goods left the business against an outbound bill, so there is
  // no balance to draw down and nothing left to decide.
  SOLD: 'Sold',
};

// Outstanding work: a lot still holding quantity at its stage, or stock sitting
// in the warehouse not yet closed out. Forwarded means the lot fully moved on,
// Closed means someone confirmed it is done with, and Sold means it is not ours
// any more -- none of the three needs attention.
const OPEN_STATUSES = [STATUS.PENDING, STATUS.PARTIAL, STATUS.IN_STOCK];

// The destinations a party may be tagged as serving, and the twin of the CHECK
// on stitching_party_uses (079, rebuilt by 087).
//
// Derived from the graph rather than listed again: a party may be tagged for
// exactly those places something can be SENT. Processing falls out on its own --
// it is never a destination, because material enters the chain there on a receipt.
const PARTY_USE_STAGES = [...new Set(Object.values(DESTINATIONS).flat())];

const isValidPartyUse = (s) => PARTY_USE_STAGES.includes(s);

// The kinds of goods a challan may carry. A quality grade chosen per dispatch,
// not per lot: one lot can go out Fresh to one party and Second to another.
const CHALLAN_TYPES = ['Fresh', 'Second', 'Third'];

const isValidChallanType = (s) => CHALLAN_TYPES.includes(s);

// The stages that count DOZENS, and count nothing else. Processing is the last
// stage that deals in metres. A challan leaving it records the metres sent and
// the dozens that came back -- that is where fabric becomes pieces -- and from
// Stitching on, a lot's quantity, its balance and every challan out of it are
// dozens. A lot does not go back to being metres because it moved.
//
// Metres are not forgotten: every dozen lot carries the metres-per-dozen yield
// of the challan (or receipt) where it was converted, because the per-dozen rate
// total needs it to price the per-metre PO rate.
const DOZEN_STAGES = ['Stitching', 'Packing', 'Panchal', 'Third Party'];

const countsDozens = (stage) => DOZEN_STAGES.includes(stage);

// The unit a lot at this stage is counted in, and its balance kept in.
const balanceUnitFor = (stage) => (countsDozens(stage) ? 'dz' : 'm');

// Every challan rate is PER DOZEN, and names the stage being LEFT: the rate
// typed on a challan out of Processing is the Processing rate. Every destination
// in the graph counts dozens, so there is no per-metre challan left to price.
// Rows written before migration 087 keep their real unit in rate_unit -- per
// dozen only into Stitched or Packed, per metre otherwise -- and the rate total
// converts those rather than pretending they were per dozen.
//
// Replaces DOZEN_RATE_STAGES/pricedPerDozen, which described the old rule.
const CHALLAN_RATE_UNIT = 'dozen';

// Yield: how many metres it took to make a dozen. NOT STORED -- derived here and
// on the client from the two numbers that are, to two places.
//
// Null rather than 0 or Infinity when either half is missing or the dozens are
// zero, so the UI renders a blank instead of a number that means nothing.
const metresPerDozen = (receivedQty, receivedDozens) => {
  // Checked BEFORE the cast, because Number(null) and Number('') are both 0 --
  // which is finite, and would turn "no quantity recorded" into a yield of 0
  // rather than a blank.
  if (receivedQty == null || receivedQty === '' || receivedDozens == null || receivedDozens === '') {
    return null;
  }
  const qty = Number(receivedQty);
  const dz = Number(receivedDozens);
  if (!Number.isFinite(qty) || !Number.isFinite(dz) || dz <= 0) return null;
  return Math.round((qty / dz) * 100) / 100;
};

const isValidStage = (s) => STAGES.includes(s);

// Where a lot at this stage may be sent. Empty at the two terminal stages.
const destinationsFor = (stage) => DESTINATIONS[stage] || [];

const canSendTo = (fromStage, toStage) => destinationsFor(fromStage).includes(toStage);

// The FIRST destination, which is the one the chooser pre-selects. It is no
// longer "the next stage" in any binding sense: the user picks, and create()
// validates the pick against destinationsFor(). Kept under the old name because
// the form wants the usual answer selected rather than an empty chooser.
const nextStage = (stage) => destinationsFor(stage)[0] || null;

// There is deliberately no prevStage any more. It described a strictly linear
// chain -- "the stage before this one" -- and the chain branches now, so a lot at
// Packing may have come from Processing or from Stitching and the question has no
// single answer. Every caller that wanted it actually wanted the parent row,
// which the lot already carries as parent_src/parent_id.

const REVERT_REASON_MAX = 300;

const revertReasonError = (value) => {
  const text = String(value ?? '').trim();
  if (!text) return 'A reason is required to withdraw this challan';
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

// How much of a lot has not yet been sent onward, IN THE LOT'S OWN UNIT --
// metres at Processing, dozens from Stitching on (see balanceUnitFor).
// `forwarded` is the sum of live children's sent_qty or sent_dozens to match --
// what LEFT this lot, not what arrived at the next stage, since the shortfall
// between the two is process loss and belongs to the child.
const balanceOf = (receivedQty, forwarded) => Number(receivedQty || 0) - Number(forwarded || 0);

// Mirrors computeLineStatus in outboundPOs.controller.js in spirit: a small pure
// function over quantities, never a user-supplied value.
//
// The two terminal stages are special, and only they are. Panchal is the
// warehouse: balance is meaningless there because nothing forwards out, so it
// reads In Stock until someone closes it, which is what records the goods
// leaving. Third Party is the exit and reads Sold flat -- there is no state to
// track once material is not ours.
//
// Packing carried the In Stock rule until Panchal existed, because the chain had
// nowhere else to end. It is an ordinary forwarding stage now and reads
// Pending/Partial/Forwarded like Processing and Stitching do.
//
// receivedQty is the lot's quantity in ITS OWN UNIT -- the caller passes dozens
// for a dozen stage -- so the same comparison works on both sides of the switch.
// There is no In Transit here, and that is a decision rather than an omission.
// Adding a challan IS sending the lot on, so a row never exists in a state where
// the goods have left but not arrived. Shortage is a quantity, not a state: a
// challan sent 40 and back 38 is an ordinary lot holding 38 with 2 short.
const computeStatus = ({ stage, receivedQty, forwarded, closedAt }) => {
  if (stage === EXIT_STAGE) return STATUS.SOLD;
  if (stage === STOCK_STAGE) return closedAt ? STATUS.CLOSED : STATUS.IN_STOCK;
  const balance = balanceOf(receivedQty, forwarded);
  if (balance <= EPSILON) return STATUS.FORWARDED;
  if (Number(forwarded || 0) > EPSILON) return STATUS.PARTIAL;
  return STATUS.PENDING;
};

// The SQL twin of computeStatus, for filtering and sorting a list by status.
// Deliberately duplicated rather than derived in JS after the fact, because
// paging has to happen in the database — filtering afterwards would return short
// pages. A parity test pins the two together, exactly as outboundPOFlags.js
// does for its flag predicates.
const statusSql = (stageCol, qtyCol, forwardedCol, closedAtCol) => `CASE
  WHEN ${stageCol} = '${EXIT_STAGE}' THEN '${STATUS.SOLD}'
  WHEN ${stageCol} = '${STOCK_STAGE}' THEN
    CASE WHEN ${closedAtCol} IS NOT NULL THEN '${STATUS.CLOSED}' ELSE '${STATUS.IN_STOCK}' END
  WHEN ${qtyCol} - ${forwardedCol} <= ${EPSILON} THEN '${STATUS.FORWARDED}'
  WHEN ${forwardedCol} > ${EPSILON} THEN '${STATUS.PARTIAL}'
  ELSE '${STATUS.PENDING}'
END`;

// Money fields accept positive decimals to two places. Zero is allowed and
// meaningful -- a free job genuinely costs 0 rather than nothing being known. Returns an error string, or null when usable.
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

// The challan a dispatch travels under. It belongs to the DISPATCH -- the row
// created when part of a lot is sent on -- not to the lot it came out of: one
// lot has many challans, and each describes a single hand-over. Migration 073
// makes the number unique within a lot, since two physical challans always have
// two numbers and the number is the only thing telling two dispatches apart.
//
// Free text, deliberately. The user was asked whether "numerical" should mean
// digits-only and chose free text, the same call already made for Incoming No.
// Do not add a digits-only rule without asking again -- challan books that use a
// prefix or a slash would stop being enterable.
//
// Blank is checked at the point of dispatch, which requires one, rather than
// here, so that an edit clearing an unrelated field is not forced to supply it.
const CHALLAN_MAX = 50;

const challanError = (value) => {
  const text = String(value ?? '').trim();
  if (text.length > CHALLAN_MAX) return `Challan No must be ${CHALLAN_MAX} characters or less`;
  return null;
};

// Writing material off destroys a quantity on paper, so the reason is the whole
// record -- "where did 60 go" has to be answerable a year later. Required for the
// same reason a withdrawal's is, and separate from it because the two say
// different things: one is material gone, the other is a row that should never
// have existed.
const WRITE_OFF_REASON_MAX = 300;

const writeOffReasonError = (value) => {
  const text = String(value ?? '').trim();
  if (!text) return 'A reason is required to write material off';
  if (text.length > WRITE_OFF_REASON_MAX) {
    return `Reason can be at most ${WRITE_OFF_REASON_MAX} characters`;
  }
  return null;
};

// Quantities use the same 2dp rule but must be strictly positive -- sending or
// receiving zero of something is not a thing that happens. A challan where
// NOTHING came back is not a challan that arrived empty, it is material gone, and
// it is recorded as a write-off against the lot instead.
const qtyError = (value, label) => {
  if (value == null || value === '') return `${label} is required`;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return `${label} must be a number > 0`;
  if (Math.abs(Math.round(n * 100) - n * 100) > 1e-9) {
    return `${label} can have at most 2 decimal places`;
  }
  return null;
};

// A party's short form for the "Stitching - SKT" tags: the master's short name
// when an admin set one, otherwise the initials of the name. Initials take the
// first letter of each word, so "Shree Krishna Textiles" reads SKT and a
// one-word name keeps its first three letters rather than a lone letter.
const partyShort = (name, shortName) => {
  const set = String(shortName ?? '').trim();
  if (set) return set;
  const words = String(name ?? '').trim().split(/[\s.&,-]+/).filter(Boolean);
  if (!words.length) return '';
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
  return words.map(w => w[0]).join('').toUpperCase();
};

// "<Stage> - <party short>" -- how a party picked on a challan is shown under the
// PO party it all started with.
const partyTag = (stage, name, shortName) => `${stage} - ${partyShort(name, shortName)}`;

// THE PER-DOZEN RATE TOTAL. components are the lot's rates as they were
// entered, each with its unit: [{ label, rate, unit: 'metre'|'dozen' }].
// A per-metre rate costs (rate x metres-per-dozen) per dozen. A per-dozen rate
// is already there. The total is only meaningful once the lot has a yield --
// before it (a lot still at Processing) every component is per metre, so the
// total is returned per metre instead and says so in `unit`.
//
// Returns { total, unit, lines }. Each line keeps the original rate and unit
// next to what it contributed, which is exactly what the tooltip spells out.
const round2 = (n) => Math.round(n * 100) / 100;

const rateTotal = (components, mPerDozen) => {
  const present = (components || []).filter(c => c.rate != null && c.rate !== '');
  const mpd = mPerDozen == null ? null : Number(mPerDozen);
  const perDozen = mpd != null && Number.isFinite(mpd) && mpd > 0;
  const lines = present.map(c => {
    const rate = Number(c.rate);
    let value;
    if (perDozen) value = c.unit === 'dozen' ? rate : rate * mpd;
    // No yield yet: only per-metre rates can be summed honestly. A per-dozen one
    // cannot exist here -- a lot with no yield has never been counted in dozens.
    else value = c.unit === 'dozen' ? null : rate;
    return { label: c.label, rate, unit: c.unit, contributes: value == null ? null : round2(value) };
  });
  const total = round2(lines.reduce((sum, l) => sum + (l.contributes || 0), 0));
  return { total: lines.length ? total : null, unit: perDozen ? 'dozen' : 'metre', m_per_dozen: perDozen ? mpd : null, lines };
};

module.exports = {
  STAGES, STATUS, OPEN_STATUSES, EPSILON,
  DESTINATIONS, EXIT_STAGE, STOCK_STAGE, DOZEN_STAGES, CHALLAN_RATE_UNIT,
  PARTY_USE_STAGES, CHALLAN_TYPES,
  REVERT_REASON_MAX, WRITE_OFF_REASON_MAX, CHALLAN_MAX,
  isValidStage, isValidPartyUse, isValidChallanType, countsDozens, balanceUnitFor, metresPerDozen,
  partyShort, partyTag, rateTotal,
  nextStage, destinationsFor, canSendTo,
  effectiveAfterRate, balanceOf, computeStatus, statusSql,
  moneyError, qtyError, revertReasonError, writeOffReasonError, challanError,
};
