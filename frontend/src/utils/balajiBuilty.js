// Balaji Builty field rules (migration 108).
//
// MIRRORS backend/src/services/balajiBuilty.service.js (and, for the Bill no
// format, backend/src/services/billNo.js) -- the server enforces, this gives
// the same answer before the request goes out. Change a rule or a message on
// one side and change it on the other: the messages are verbatim.
//
// Every field is typed by hand. Vendor is the one required field, because the
// page's tabs are its distinct vendors. The rules run in column order, so both
// sides name the same field first.
import { isValidDateString } from './dateValidation';

// The editable columns, in the grid's order.
export const FIELDS = [
  'po_date', 'vendor', 'party_name', 'vendor_po_id', 'qty', 'city',
  'expiry_date', 'dispatch_date', 'courier', 'tracking_id', 'bill_no', 'bill_date',
];

export const LABELS = {
  po_date: 'Order Date',
  vendor: 'Vendor',
  party_name: 'Party Name',
  vendor_po_id: 'PO No.',
  qty: 'Quantity',
  city: 'City',
  expiry_date: 'Expiry Date',
  dispatch_date: 'Dispatch Date',
  courier: 'Courier',
  tracking_id: 'Tracking ID',
  bill_no: 'Bill no',
  bill_date: 'Bill Date',
};

export const DATE_FIELDS = ['po_date', 'expiry_date', 'dispatch_date', 'bill_date'];
export const TEXT_MAX = 200;
export const QTY_MAX = 10000000;
export const BILL_NO_RE = /^[A-Za-z0-9/-]+$/;
export const BILL_NO_MESSAGE = 'Bill no may contain only letters, digits, dashes and slashes';

const isBlank = (v) => v == null || String(v).trim() === '';

function fieldError(key, v) {
  const label = LABELS[key];
  if (key === 'vendor') {
    if (isBlank(v)) return 'Vendor is required';
  }
  if (isBlank(v)) return null;
  const s = String(v).trim();
  if (DATE_FIELDS.includes(key)) {
    return isValidDateString(s) ? null : `${label} is not a valid date`;
  }
  if (key === 'qty') {
    if (!/^\d+$/.test(s)) return 'Quantity must be a whole number, 0 or more';
    return Number(s) > QTY_MAX ? `Quantity must be at most ${QTY_MAX}` : null;
  }
  if (s.length > TEXT_MAX) return `${label} must be at most ${TEXT_MAX} characters`;
  if (key === 'bill_no' && !BILL_NO_RE.test(s)) return BILL_NO_MESSAGE;
  return null;
}

// A whole entry (every field, as it will be saved) -> error string or null.
export function entryFieldsError(values) {
  const v = values || {};
  for (const key of FIELDS) {
    const err = fieldError(key, v[key]);
    if (err) return err;
  }
  if (!isBlank(v.bill_no) && isBlank(v.bill_date)) return 'Bill date is required when setting a bill no';
  return null;
}

// ---- Client only (no server twin) -------------------------------------------

// A blank entry, as form state.
export const emptyEntry = () => Object.fromEntries(FIELDS.map((f) => [f, '']));

// The free-text fields that suggest values used before, and the /options list
// each one draws on.
export const SUGGESTIONS = { vendor: 'vendors', party_name: 'party_names', city: 'cities', courier: 'couriers' };

// Codes, shown in a monospace font.
export const MONO_FIELDS = ['vendor_po_id', 'tracking_id', 'bill_no'];
