// Pure helpers shared by the PO detail page and the receipt add/edit modal.
//
// These used to live inside OutboundPODetail and close over its state. They are
// here, and take their data as arguments, because ReceiptModal needs the same
// rules and duplicating them would let the two drift — which matters most for
// receiptFieldError, whose whole point is to reproduce the server's answer.

import { moneyError, qtyError, defaultAfterRate, STAGES, EPSILON } from '../../utils/stitching';

// Twin of INCOMING_NO_MAX in backend/src/controllers/outboundPOs.controller.js,
// keep the two in step.
export const INCOMING_NO_MAX = 50;

export const EMPTY_RECEIPT = {
  received_qty: '', received_rate: '', bill_no: '', incoming_no: '', checked_by: '',
  process_rate: '', after_rate: '', incoming_stage: '',
  qty_in_metres: '', qty_diff_action: '', qty_diff_reason: '',
};

// Only fabric travels the Stitching stages, so only fabric has a stage and a
// metres figure. The flag lives on the outbound product master and rides down
// on the PO line.
export const isFabricLine = (line) => Number(line?.goes_to_stitching) === 1;

// A receipt can arrive at any stage EXCEPT Third Party, which is where material
// leaves us -- nothing is ever bought into it. Twin of RECEIPT_STAGES on the
// server.
export const RECEIPT_STAGES = STAGES.filter(s => s !== 'Third Party');

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
  if (!v.checked_by) return 'Checked By is required';
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
// Gray -> Processed -> Stitched -> Packed the way the material actually moves.
//
// A STAGE, not a prefix. Nobody picks a prefix anywhere any more: the stage is
// the fact being recorded, and the code that prints on it follows from it on the
// server. That also means a receipt keeps rendering a prefix that has since been
// deactivated without the dropdown having to carry it as an option.
export function stageOptionsFor() {
  return RECEIPT_STAGES.map(stage => ({ value: stage, label: stage }));
}

// If a receipt's stored checker isn't in the live Warehouse_POC list (tagged
// before the rule existed, or since untagged), keep them selectable so the
// dropdown doesn't silently blank out a real recorded value.
export function checkerOptionsFor(checkers, checkedById, checkedByName) {
  const opts = (checkers || []).map(u => ({ value: u.id, label: u.name }));
  if (checkedById && !opts.some(o => String(o.value) === String(checkedById))) {
    opts.push({ value: checkedById, label: `${checkedByName || 'Unknown'} (not Warehouse POC)` });
  }
  return opts;
}
