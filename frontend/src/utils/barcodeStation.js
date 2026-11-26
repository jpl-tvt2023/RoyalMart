// Barcode Station field rules (migration 098).
//
// MIRROR of backend/src/services/barcodeStation.service.js -- the server
// enforces, this gives instant feedback, and both must reject the same input
// with the SAME message. batchFieldsError checks the fields in the order the
// grid shows them, so both sides name the same field first. Change one side,
// change the other: backend tests/barcodeStation.test.js and
// src/utils/__tests__/barcodeStation.test.js assert the same strings.

export const KEY_MIN = 10000000;
export const KEY_MAX = 99999999;
export const KEY_RE = /^[1-9]\d{7}$/;

export const PACK_SIZE_MAX = 1000000;
export const LABEL_COUNT_MAX = 2000;
export const OPERATOR_MAX = 60;

// How the station prints (migration 100): `dialog` through the browser's print
// dialog, `direct` for kiosk PCs (Chrome/Edge with --kiosk-printing).
export const PRINT_MODES = ['dialog', 'direct'];

export const PIN_RE = /^\d{4,8}$/;

export const LABEL_WIDTH_MIN = 20;
export const LABEL_WIDTH_MAX = 300;
export const LABEL_HEIGHT_MIN = 10;
export const LABEL_HEIGHT_MAX = 300;

const isBlank = (v) => v == null || String(v).trim() === '';

function pickError(value, label) {
  if (isBlank(value) || !/^\d+$/.test(String(value).trim()) || Number(value) < 1) return `${label} is required`;
  return null;
}

export function wholeNumberError(value, label, max) {
  if (isBlank(value)) return `${label} is required`;
  const s = String(value).trim();
  if (!/^\d+$/.test(s)) return `${label} must be a whole number`;
  const n = Number(s);
  if (n < 1) return `${label} must be at least 1`;
  if (n > max) return `${label} cannot be more than ${max}`;
  return null;
}

// Vendor, Article, Pack Size, Floor, Number of Barcodes -- grid order.
export function batchFieldsError(f) {
  const v = f || {};
  return pickError(v.outbound_vendor_id, 'Vendor')
    || pickError(v.article_id, 'Article')
    || wholeNumberError(v.pack_size, 'Pack Size', PACK_SIZE_MAX)
    || pickError(v.floor_id, 'Floor')
    || wholeNumberError(v.label_count, 'Number of Barcodes', LABEL_COUNT_MAX);
}

export const normOperator = (v) => (v == null ? '' : String(v).trim().replace(/\s+/g, ' '));

export function operatorError(value) {
  const name = normOperator(value);
  if (!name) return 'Operator name is required';
  if (name.length > OPERATOR_MAX) return `Operator name cannot be longer than ${OPERATOR_MAX} characters`;
  return null;
}

export function printModeError(value) {
  return PRINT_MODES.includes(value) ? null : 'Print mode must be dialog or direct';
}

export function keyError(value) {
  if (isBlank(value)) return 'Key is required';
  if (!KEY_RE.test(String(value).trim())) return 'Key must be 8 digits';
  return null;
}

export function pinError(value) {
  if (isBlank(value)) return 'PIN is required';
  if (!PIN_RE.test(String(value).trim())) return 'PIN must be 4 to 8 digits';
  return null;
}

export function labelSizeError(width, height) {
  const range = (v, label, min, max) => {
    if (isBlank(v)) return `${label} is required`;
    const s = String(v).trim();
    if (!/^\d+$/.test(s) || Number(s) < min || Number(s) > max) return `${label} must be a whole number of mm from ${min} to ${max}`;
    return null;
  };
  return range(width, 'Sticker width', LABEL_WIDTH_MIN, LABEL_WIDTH_MAX)
    || range(height, 'Sticker height', LABEL_HEIGHT_MIN, LABEL_HEIGHT_MAX);
}

// ---- Client-only helpers (no backend twin) ---------------------------------

// The station's article label -- the same "Category · Item · Variant" the rest
// of the outbound screens show (receiptFields.js#mapLabel).
export const articleLabel = (a) => (a ? `${a.category} · ${a.item_name}${a.variant ? ` · ${a.variant}` : ''}` : '');

export const packSizeLabel = (b) => (b ? `${b.pack_size}${b.unit_metric ? ` ${b.unit_metric}` : ''}` : '');

// "180 keys" / "1 key"
export const keyCountLabel = (n) => `${n} key${Number(n) === 1 ? '' : 's'}`;

// "printed 2×" / "not printed yet"
export const printCountLabel = (n) => (Number(n) > 0 ? `printed ${n}×` : 'not printed yet');
