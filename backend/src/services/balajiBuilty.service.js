// Balaji Builty field rules (migration 108).
//
// MIRRORED in frontend/src/utils/balajiBuilty.js -- the server enforces, the
// client rejects the same entry with the same words before it posts. Change a
// rule or a message on one side and change it on the other.
//
// Every field is typed by hand (free text -- client, 2026-11-28). Vendor is the
// one required field, because the page's tabs are its distinct vendors. The
// rules run in column order, so both sides name the same field first.
const { isValidDateString } = require('../utils/dateValidation');
const { BILL_NO_RE, BILL_NO_MESSAGE } = require('./billNo');

// The editable columns, in the grid's order.
const FIELDS = [
  'po_date', 'vendor', 'party_name', 'vendor_po_id', 'qty', 'city',
  'expiry_date', 'dispatch_date', 'courier', 'tracking_id', 'bill_no', 'bill_date',
];

const LABELS = {
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

const DATE_FIELDS = ['po_date', 'expiry_date', 'dispatch_date', 'bill_date'];
const TEXT_MAX = 200;
const QTY_MAX = 10000000;

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
function entryFieldsError(values) {
  const v = values || {};
  for (const key of FIELDS) {
    const err = fieldError(key, v[key]);
    if (err) return err;
  }
  if (!isBlank(v.bill_no) && isBlank(v.bill_date)) return 'Bill date is required when setting a bill no';
  return null;
}

// The fields present in `body`, trimmed, '' -> null, Quantity as a number.
// Fields not sent are left out, so a PATCH touches only what it names.
function normEntry(body) {
  const b = body || {};
  const out = {};
  for (const key of FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) continue;
    const v = b[key];
    if (isBlank(v)) { out[key] = null; continue; }
    const s = String(v).trim();
    out[key] = key === 'qty' && /^\d+$/.test(s) ? Number(s) : s;
  }
  return out;
}

module.exports = { FIELDS, LABELS, DATE_FIELDS, TEXT_MAX, QTY_MAX, entryFieldsError, normEntry };
