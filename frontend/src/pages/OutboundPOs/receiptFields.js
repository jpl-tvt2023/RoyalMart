// Pure helpers shared by the PO detail page and the receipt add/edit modal.
//
// These used to live inside OutboundPODetail and close over its state. They are
// here, and take their data as arguments, because ReceiptModal needs the same
// rules and duplicating them would let the two drift — which matters most for
// receiptFieldError, whose whole point is to reproduce the server's answer.

import {
  moneyError, qtyError, STAGES, EPSILON, countsDozens, metresPerDozen,
  isGradedStage, CHALLAN_TYPES, GRADE_COLUMNS, EXIT_STAGE, isCheckerStage,
  umKind, countsInDozens, derivedDozens, receiptHasMetres, receiptStageBlockReason,
} from '../../utils/stitching';

// Twin of INCOMING_NO_MAX in backend/src/controllers/outboundPOs.controller.js,
// keep the two in step.
export const INCOMING_NO_MAX = 50;

// A receipt's Note is a paragraph, capped only against a paste accident. Twin of
// NOTE_MAX in backend/src/controllers/outboundPOs.controller.js, keep in step.
export const NOTE_MAX = 1000;

// The rate billed on a receipt -- like the agreed rate on its line -- is quoted
// to at most 3 decimal places (socks at 0.156 a piece). Twin of RATE_DECIMALS in
// backend/src/controllers/outboundPOs.controller.js, same message, same slot.
export const RATE_DECIMALS = 3;
const tooManyRateDecimals = (n) =>
  Math.abs(Math.round(n * 10 ** RATE_DECIMALS) - n * 10 ** RATE_DECIMALS) > 1e-6;

// The three grades start at 0 -- the client's default -- and only mean anything
// on goods received at Packing, Panchal or Third Party (receiptIsGraded).
// outbound_bill_no is asked only at Third Party. checked_by is asked on every
// receipt that never reaches the Stitching page, and at Panchal and Third Party
// on one that does (receiptTakesChecker).
export const EMPTY_RECEIPT = {
  received_qty: '', unit_metric: '', received_rate: '', bill_no: '', incoming_no: '',
  process_rate: '', incoming_stage: '',
  qty_in_metres: '', received_dozens: '', qty_diff_action: '', qty_diff_reason: '',
  fresh_dozens: '0', second_dozens: '0', third_dozens: '0', note: '',
  outbound_bill_no: '', checked_by: '',
};

// Whether this line's article travels the Stitching stages -- the "Goes through
// Stitching" tick on the outbound product master, riding down on the PO line.
// HOW it travels is the receipt's UM: bought in dozens or pieces it is made up
// and skips Processing.
//
// A MISSING field reads as "travels nothing", indistinguishably from a genuine
// packaging line. That is why toLineState below lives in this file and is
// pinned by a test: the tick going astray on the way to the modal is silent,
// and shows up only as a server rejection the form never warned about.
export const isStitchingLine = (line) => Number(line?.goes_to_stitching) === 1;

// What a receipt's unit metric means -- dozen, metre, piece or nothing in
// particular (umKind) -- read off the receipt's own UM, else the line's.
export const receiptUmKind = (v, line) => umKind(String(v?.unit_metric ?? '').trim() || line?.unit_metric);

// Twin of receiptHasMetres on the server, for a line: metres only on a
// stitching line, and not when it was bought in dozens or pieces.
export const receiptTakesMetres = (line, kind) => isStitchingLine(line) && receiptHasMetres(kind);

// The dozens a receipt's UM already settles at this stage -- a Received Qty in
// dozens, or in pieces -- or null when they have to be typed. Twin of the
// server's dozensFromQty + derivedDozens. `derivable` says whether the UM
// settles them at all, so the form can hide the field before a quantity is typed.
export const receiptDozensDerivable = (line, kind, stage) =>
  isStitchingLine(line) && countsDozens(stage) && countsInDozens(kind);

export const receiptSettledDozens = (v, line, kind) => (
  receiptDozensDerivable(line, kind, v?.incoming_stage) ? derivedDozens(v?.received_qty, kind) : null
);

// An article's identity: the tuple, joined so it can live in a <select> value.
// Matches are case-insensitive, like the backend's.
export const mapKey = (a) => `${a.category}${a.item_name}${a.variant || ''}`.toLowerCase();

export const mapLabel = (a) => `${a.category} · ${a.item_name}${a.variant ? ` · ${a.variant}` : ''}`;

// A blank line for the detail page's editable grid. Keep its keys in step with
// toLineState's — a test asserts the two agree, so a field added to one cannot
// quietly go missing from the other.
export const emptyLine = () => ({
  _key: `new-${Math.random().toString(36).slice(2)}`,
  id: null, mapping: '', category: '', item_name: '', variant: '',
  qty: 1, rate: 0, short: 0, received: 0, receipts: [], unit_metric: '', flags: [],
  goes_to_stitching: 0,
  updated_by_name: '', updated_at: null, deleted_at: null, deleted_by: null,
});

// The server's line row, projected into the shape the detail page's form binds
// to. It is an allowlist rather than a spread because the form owns _key and
// mapping, which the server knows nothing about.
//
// It lives HERE, not in the page, for the reason at the top of this file: the
// page and the modal must not drift. ReceiptModal is opened from this projected
// state, so anything the modal reads has to survive the projection — and
// goes_to_stitching once did not, which suppressed the Stage, Qty in metres and
// Dozens fields on every fabric line while the server went on demanding them.
export function toLineState(l) {
  return {
    _key: String(l.id),
    id: l.id,
    mapping: mapKey(l),
    category: l.category, item_name: l.item_name, variant: l.variant || '',
    qty: l.qty, rate: l.rate, short: l.short, received: l.received,
    unit_metric: l.unit_metric || '',
    flags: l.flags || [],
    // Server-derived, and the modal's ONLY signal that this line travels the
    // stitching stages. Defaulted rather than passed through so a row that
    // predates the flag reads as non-stitching instead of NaN.
    goes_to_stitching: l.goes_to_stitching ?? 0,
    updated_by_name: l.updated_by_name, updated_at: l.updated_at,
    deleted_at: l.deleted_at, deleted_by: l.deleted_by,
    receipts: l.receipts || [],
  };
}

// A receipt can arrive at ANY stage. Third Party joined in migration 091: goods
// bought and sold straight on, without entering our stock. Processing is
// refused per receipt rather than here -- for goods bought in dozens or pieces
// -- and shown disabled with its reason (stageOptionsFor). Twin of
// RECEIPT_STAGES on the server.
export const RECEIPT_STAGES = [...STAGES];

// Goods bought in ALREADY STITCHED, PACKED, into the warehouse or straight out
// to a buyer arrive as countable pieces, so they carry a dozen count exactly as
// a challan into those stages does. Keyed on the stage being received at: a
// Processing receipt has no pieces to count. Reads countsDozens, so it widened
// with DOZEN_STAGES rather than needing its own list.
export const receiptCountsDozens = (line, incomingStage) =>
  isStitchingLine(line) && countsDozens(incomingStage);

// Goods bought in at Packing, Panchal or Third Party arrive GRADED (migration
// 089): their dozens are typed as Fresh, Second and Third, and Dozens Received
// is their sum. Stitching counts dozens but is not graded.
export const receiptIsGraded = (line, incomingStage) =>
  isStitchingLine(line) && isGradedStage(incomingStage);

// A sale straight out to a buyer (091): no incoming number, our outbound bill,
// and a Warehouse POC who checked it -- the challan into Third Party's terms.
export const receiptIsSale = (line, incomingStage) =>
  isStitchingLine(line) && incomingStage === EXIT_STAGE;

// Whether a receipt is checked over by a Warehouse POC as it is received. Goods
// that never reach the Stitching page are checked here or never, so every one
// of those receipts asks. A stitching line asks only at Panchal and Third Party
// -- the challan's CHECKER_STAGES; anywhere earlier its goods are checked on the
// challan into Panchal. Twin of receiptTakesChecker on the server.
export const receiptTakesChecker = (line, incomingStage) =>
  !isStitchingLine(line) || isCheckerStage(incomingStage);

// The grade inputs, in type order: [['Fresh', 'fresh_dozens'], ...].
export const GRADE_FIELDS = CHALLAN_TYPES.map(t => [t, GRADE_COLUMNS[t]]);

// Dozens Received on a graded receipt, to two places.
export const receiptGradeTotal = (v) => Math.round(
  GRADE_FIELDS.reduce((s, [, col]) => s + (Number(v?.[col]) || 0), 0) * 100,
) / 100;

// The yield, for the read-only field beside the count. Re-exported here so the
// receipt modal and the stitching page compute it the same way.
export { metresPerDozen };

// What is still due on a line: ordered, less what has arrived, less what has
// been written off as never coming. The number a delivery is measured against,
// and the same arithmetic the detail page's Pending column uses.
export const outstandingOf = (line) =>
  Math.max(0, Number(line?.qty || 0) - Number(line?.received || 0) - Number(line?.short || 0));

// What this delivery is over or under by. Negative is short, positive is over,
// and null while the user has typed nothing.
export function qtyDifference(receivedQty, line) {
  if (receivedQty === '' || receivedQty == null) return null;
  const n = Number(receivedQty);
  if (!Number.isFinite(n)) return null;
  return Math.round((n - outstandingOf(line)) * 100) / 100;
}

// Which box the difference earns. Exactly one is ever offered, so a delivery
// that matches offers neither. Twin of qtyDiffAction on the server.
export function offeredQtyDiffAction(difference) {
  if (difference == null || Math.abs(difference) <= EPSILON) return null;
  return difference < 0 ? 'write_off' : 'rollover';
}

// Mirrors the server's receipt rules — including their ORDER, so the message
// shown here is the one the server would have returned — so the user gets the
// error before a round trip. Returns an error string, or null when usable.
//
// requireBillNo is false only when editing a receipt that has never had one
// (migration 053 synthesized those from the legacy flat `received` value, with
// no bill to record). Those stay editable for unrelated fixes rather than
// demanding a bill number nobody has — matching what the server enforces.
//
// requireChecker is false, likewise, only when editing a receipt that has no
// checker stored and is not changing stage -- 053's synthesized rows, which
// predate Checked By. The server judges a checker only when one is sent or the
// stage moves.
export function receiptFieldError(v, { requireBillNo = true, requireChecker = true, line = null } = {}) {
  const stitching = isStitchingLine(line);
  const kind = receiptUmKind(v, line);
  const stage = String(v.incoming_stage ?? '').trim();

  // THE STAGE, first: it heads the form because everything below reshapes to
  // it, and the server checks it before anything else too (receiptStageError).
  if (stitching) {
    if (!stage) return 'Stage is required';
    const blocked = receiptStageBlockReason(stage, kind);
    if (blocked) return blocked;
  }

  if (!v.received_qty || Number(v.received_qty) <= 0) return 'Received Qty is required';
  if (v.received_rate === '' || v.received_rate == null) return 'Billed Rate is required';
  if (!Number.isFinite(Number(v.received_rate)) || Number(v.received_rate) < 0) return 'Billed Rate must be a number >= 0';
  if (tooManyRateDecimals(Number(v.received_rate))) return `Billed Rate can have at most ${RATE_DECIMALS} decimal places`;
  if (requireBillNo && !String(v.bill_no ?? '').trim()) return 'Bill No is required';
  if (v.incoming_no !== '' && v.incoming_no != null) {
    const s = String(v.incoming_no).trim();
    if (!s) return 'Incoming No cannot be blank';
    if (s.length > INCOMING_NO_MAX) return `Incoming No must be ${INCOMING_NO_MAX} characters or less`;
  }
  // Appended after the existing rules, matching the server's ordering.
  const procErr = moneyError(v.process_rate, 'Process Rate');
  if (procErr) return procErr;

  if (stitching) {
    const sale = stage === EXIT_STAGE;
    // Nothing arrives at Third Party, so it takes no incoming number. Everywhere
    // else on the chain one is required.
    if (sale && String(v.incoming_no ?? '').trim()) return 'Third Party takes no Incoming No — nothing arrives there';
    if (!sale && !String(v.incoming_no ?? '').trim()) return 'Incoming No is required';

    // Metres only on Fabric, and only typed when the UM is not metres itself.
    if (receiptTakesMetres(line, kind) && kind !== 'metre') {
      const metresErr = qtyError(v.qty_in_metres, 'Qty in metres');
      if (metresErr) return metresErr;
    }

    // At a graded stage the dozens are the grades below, not a figure of their
    // own. A UM in dozens or pieces settles them outright.
    const settled = receiptSettledDozens(v, line, kind);
    if (countsDozens(stage) && !isGradedStage(stage) && settled == null) {
      const dozensErr = qtyError(v.received_dozens, 'Dozens Received');
      if (dozensErr) return dozensErr;
    }
    // Twin of the server's grade check, in the same slot: each grade 0 or a
    // positive 2dp figure, and together something -- the settled figure, when
    // the UM already says how many dozens arrived.
    if (isGradedStage(stage)) {
      for (const [gradeType, col] of GRADE_FIELDS) {
        const gradeErr = moneyError(v[col], `${gradeType} dozens`);
        if (gradeErr) return gradeErr;
      }
      const total = receiptGradeTotal(v);
      if (total <= EPSILON) return 'Enter the dozens for at least one grade';
      if (settled != null && Math.abs(settled - total) > EPSILON) {
        return `Fresh + Second + Third must add up to ${settled} dozen`;
      }
    }

    // A sale's outbound bill, in the slot the server checks it.
    if (sale) {
      const bill = String(v.outbound_bill_no ?? '').trim();
      if (!bill) return 'Outbound Bill No is required when sending to a third party';
      if (bill.length > INCOMING_NO_MAX) return `Outbound Bill No must be ${INCOMING_NO_MAX} characters or less`;
    }
  }

  // The checker, in the slot the server checks it -- the same one for a
  // stitching line and for goods that never reach the Stitching page. The list
  // offers Warehouse POCs only, so the role half needs no twin here.
  if (requireChecker && receiptTakesChecker(line, stage) && (v.checked_by === '' || v.checked_by == null)) {
    return 'Checked By is required';
  }

  // A ticked box has to say why, and has to match the difference it explains.
  if (v.qty_diff_action) {
    if (!String(v.qty_diff_reason ?? '').trim()) {
      return v.qty_diff_action === 'write_off'
        ? 'A reason is required to write off the shortfall'
        : 'A reason is required to roll over the excess';
    }
    if (String(v.qty_diff_reason).trim().length > 300) {
      return 'Reason can be at most 300 characters';
    }
  }

  // The unit the delivery was counted in. LAST, in the same slot the server
  // gives it, because the first error a body with several omissions produces is
  // the contract on both sides.
  //
  // Stricter here than on the server on purpose: the server treats a missing UM
  // as "the line's own", which is what an API caller omitting it means, while
  // the form has already pre-filled that same value and so can insist on one.
  if (!String(v.unit_metric ?? '').trim()) return 'UM is required';

  // Optional free text, after everything else -- the same slot the server gives it.
  if (String(v.note ?? '').trim().length > NOTE_MAX) return `Note must be ${NOTE_MAX} characters or less`;

  return null;
}

// Stage options, in process order rather than alphabetically, so the list reads
// Processing -> Stitching -> Packing -> Panchal -> Third Party the way the
// material actually moves.
//
// A STAGE, not a prefix. Nobody picks a prefix anywhere any more: the stage is
// the fact being recorded, and the code that prints on it follows from it on the
// server. That also means a receipt keeps rendering a prefix that has since been
// deactivated without the dropdown having to carry it as an option.
//
// Processing is DISABLED rather than hidden for goods bought in dozens or
// pieces, with the reason beside it, so the user sees why it cannot be picked
// (receiptStageBlockReason).
// `kind` is the umKind of the delivery's unit.
export function stageOptionsFor(kind = null) {
  return RECEIPT_STAGES.map(stage => {
    const reason = receiptStageBlockReason(stage, kind);
    return { value: stage, label: stage, disabled: !!reason, reason };
  });
}

// The stage a new receipt starts on: the first one it may take. Processing for
// goods with metres, Stitching for anything bought in dozens or pieces.
export const defaultReceiptStage = (kind) =>
  stageOptionsFor(kind).find(o => !o.disabled)?.value || '';
