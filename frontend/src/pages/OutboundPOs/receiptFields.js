// Pure helpers shared by the PO detail page and the receipt add/edit modal.
//
// These used to live inside OutboundPODetail and close over its state. They are
// here, and take their data as arguments, because ReceiptModal needs the same
// rules and duplicating them would let the two drift — which matters most for
// receiptFieldError, whose whole point is to reproduce the server's answer.

import { moneyError, defaultAfterRate, STAGES } from '../../utils/stitching';

// Twin of INCOMING_NO_MAX in backend/src/controllers/outboundPOs.controller.js,
// keep the two in step.
export const INCOMING_NO_MAX = 50;

export const EMPTY_RECEIPT = {
  received_qty: '', received_rate: '', bill_no: '', incoming_no: '', checked_by: '',
  process_rate: '', after_rate: '', incoming_prefix_id: '',
};

// Mirrors the server's receipt rules — including their ORDER, so the message
// shown here is the one the server would have returned — so the user gets the
// error before a round trip. Returns an error string, or null when usable.
//
// requireBillNo is false only when editing a receipt that has never had one
// (migration 053 synthesized those from the legacy flat `received` value, with
// no bill to record). Those stay editable for unrelated fixes rather than
// demanding a bill number nobody has — matching what the server enforces.
export function receiptFieldError(v, { requireBillNo = true } = {}) {
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
  // A prefix with no number would print as a bare "GRY" and put a phantom lot on
  // the Stitching page. The reverse is fine — a number with no stage yet is the
  // legacy shape, and raises the Missing Incoming Stage flag instead.
  if (v.incoming_prefix_id && !String(v.incoming_no ?? '').trim()) {
    return 'Incoming No is required when a prefix is selected';
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

// Prefix options as a flat list, each reading "GRY · Gray".
//
// These were briefly grouped under <optgroup> stage headings, which existed only
// to keep the COLLAPSED select narrow enough to sit in a table cell. That select
// is gone — the table shows read-only text now and the picker lives in a modal
// with room to spare — so the grouping just turned four choices into eight rows,
// each single option carrying its own heading. Flat is shorter and says the same
// thing.
//
// Sorted by stage in process order rather than alphabetically, so the list reads
// Gray → Processed → Stitched → Packed the way the material actually moves.
//
// A receipt can keep a prefix that has since been deactivated, so the stored one
// is appended and marked, or the dropdown would silently blank a real recorded
// value.
export function prefixOptionsFor(prefixes, prefixId, prefixLabel) {
  const active = (prefixes || []).filter(p => p.is_active);
  const opts = STAGES.flatMap(stage => active
    .filter(p => p.stage === stage)
    .map(p => ({ value: p.id, label: `${p.prefix} · ${stage}` })));
  if (prefixId && !active.some(p => String(p.id) === String(prefixId))) {
    opts.push({ value: prefixId, label: `${prefixLabel || 'Unknown'} (inactive)` });
  }
  return opts;
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
