// Pure helpers shared by the PO detail page and the receipt add/edit modal.
//
// These used to live inside OutboundPODetail and close over its state. They are
// here, and take their data as arguments, because ReceiptModal needs the same
// rules and duplicating them would let the two drift — which matters most for
// receiptFieldError, whose whole point is to reproduce the server's answer.

import {
  moneyError, qtyError, defaultAfterRate, STAGES, EPSILON, countsDozens, metresPerDozen,
} from '../../utils/stitching';

// Twin of INCOMING_NO_MAX in backend/src/controllers/outboundPOs.controller.js,
// keep the two in step.
export const INCOMING_NO_MAX = 50;

export const EMPTY_RECEIPT = {
  received_qty: '', unit_metric: '', received_rate: '', bill_no: '', incoming_no: '',
  process_rate: '', after_rate: '', incoming_stage: '',
  qty_in_metres: '', received_dozens: '', qty_diff_action: '', qty_diff_reason: '',
};

// Only fabric travels the Stitching stages, so only fabric has a stage and a
// metres figure. The flag lives on the outbound product master and rides down
// on the PO line.
//
// A MISSING field reads as "not fabric", indistinguishably from a genuine
// non-fabric line. That is why toLineState below lives in this file and is
// pinned by a test: the flag going astray on the way to the modal is silent,
// and shows up only as a server rejection the form never warned about.
export const isFabricLine = (line) => Number(line?.goes_to_stitching) === 1;

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
    // predates the flag reads as non-fabric instead of NaN.
    goes_to_stitching: l.goes_to_stitching ?? 0,
    updated_by_name: l.updated_by_name, updated_at: l.updated_at,
    deleted_at: l.deleted_at, deleted_by: l.deleted_by,
    receipts: l.receipts || [],
  };
}

// A receipt can arrive at any stage EXCEPT Third Party, which is where material
// leaves us -- nothing is ever bought into it. Twin of RECEIPT_STAGES on the
// server.
export const RECEIPT_STAGES = STAGES.filter(s => s !== 'Third Party');

// Fabric bought in ALREADY STITCHED, PACKED or straight into the warehouse
// arrives as countable pieces, so it carries a dozen count exactly as a challan
// into those stages does. Keyed on the stage being received at, not on fabric
// alone: a Processing receipt has no pieces to count. Reads countsDozens, so it
// widened with DOZEN_STAGES rather than needing its own list.
export const receiptCountsDozens = (line, incomingStage) =>
  isFabricLine(line) && countsDozens(incomingStage);

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
export function receiptFieldError(v, { requireBillNo = true, line = null } = {}) {
  if (!v.received_qty || Number(v.received_qty) <= 0) return 'Received Qty is required';
  if (v.received_rate === '' || v.received_rate == null) return 'Billed Rate is required';
  if (!Number.isFinite(Number(v.received_rate)) || Number(v.received_rate) < 0) return 'Billed Rate must be a number >= 0';
  if (requireBillNo && !String(v.bill_no ?? '').trim()) return 'Bill No is required';
  if (v.incoming_no !== '' && v.incoming_no != null) {
    const s = String(v.incoming_no).trim();
    if (!s) return 'Incoming No cannot be blank';
    if (s.length > INCOMING_NO_MAX) return `Incoming No must be ${INCOMING_NO_MAX} characters or less`;
  }
  // Appended after the existing rules, matching the server's ordering.
  const procErr = moneyError(v.process_rate, 'Process Rate');
  if (procErr) return procErr;
  const afterErr = moneyError(v.after_rate, 'After Rate');
  if (afterErr) return afterErr;
  // Fabric travels the stage chain and is worked in metres, so a fabric receipt
  // that names neither could never be tracked through it. Everything else has no
  // stage at all and keeps its incoming number as optional free text.
  const fabric = isFabricLine(line);
  if (fabric) {
    if (!v.incoming_stage) return 'Stage is required';
    if (!String(v.incoming_no ?? '').trim()) return 'Incoming No is required';
    const metresErr = qtyError(v.qty_in_metres, 'Qty in metres');
    if (metresErr) return metresErr;
    if (countsDozens(v.incoming_stage)) {
      const dozensErr = qtyError(v.received_dozens, 'Dozens Received');
      if (dozensErr) return dozensErr;
    }
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

  return null;
}

// After Rate tracks Received Rate + Process Rate until the user types over it,
// exactly as the server stores it. Editing either input re-derives it unless the
// value currently shown is already an override.
export function withDerivedAfterRate(draft, field, value) {
  const next = { ...draft, [field]: value };
  if (field === 'after_rate') return next;
  if (field !== 'received_rate' && field !== 'process_rate') return next;
  const wasDefault = draft.after_rate === '' || draft.after_rate == null
    || Number(draft.after_rate) === Number(draft.received_rate || 0) + Number(draft.process_rate || 0);
  if (wasDefault) next.after_rate = defaultAfterRate(next.received_rate, next.process_rate);
  return next;
}

// Stage options, in process order rather than alphabetically, so the list reads
// Processing -> Stitching -> Packing -> Panchal the way the material actually moves.
//
// A STAGE, not a prefix. Nobody picks a prefix anywhere any more: the stage is
// the fact being recorded, and the code that prints on it follows from it on the
// server. That also means a receipt keeps rendering a prefix that has since been
// deactivated without the dropdown having to carry it as an option.
export function stageOptionsFor() {
  return RECEIPT_STAGES.map(stage => ({ value: stage, label: stage }));
}

