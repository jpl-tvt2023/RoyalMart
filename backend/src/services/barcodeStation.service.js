// Barcode Station field rules (migration 098).
//
// MIRRORED in frontend/src/utils/barcodeStation.js -- the server enforces, the
// client gives instant feedback, and both must reject the same input with the
// SAME message. batchFieldsError checks the fields in the order the grid shows
// them, so both sides name the same field first. Change one side, change the
// other: tests/barcodeStation.test.js and the frontend's
// src/utils/__tests__/barcodeStation.test.js assert the same strings.

// Every key is exactly 8 digits with no leading zero, so it prints and scans
// the same whether it is read as a number or as text.
const KEY_MIN = 10000000;
const KEY_MAX = 99999999;
const KEY_RE = /^[1-9]\d{7}$/;

const PACK_SIZE_MAX = 1000000;
// One print run per batch. Chrome's print preview slows to a crawl past a few
// thousand pages, and a delivery bigger than this can be split.
const LABEL_COUNT_MAX = 2000;
const OPERATOR_MAX = 60;

// The shared station PIN: numeric, 4 to 8 digits (client's choice). Short PINs
// are why the server also keeps a database-backed, escalating lockout.
const PIN_RE = /^\d{4,8}$/;

// The sticker the print sheet is laid out at, in whole millimetres.
const LABEL_WIDTH_MIN = 20;
const LABEL_WIDTH_MAX = 300;
const LABEL_HEIGHT_MIN = 10;
const LABEL_HEIGHT_MAX = 300;

const isBlank = (v) => v == null || String(v).trim() === '';

// A picked master row: any positive integer id.
function pickError(value, label) {
  if (isBlank(value) || !/^\d+$/.test(String(value).trim()) || Number(value) < 1) return `${label} is required`;
  return null;
}

// A typed count: a whole number from 1 to max. Accepts a number or a digit
// string -- "300.0", "3e2" and "-1" are all refused, on both sides alike.
function wholeNumberError(value, label, max) {
  if (isBlank(value)) return `${label} is required`;
  const s = String(value).trim();
  if (!/^\d+$/.test(s)) return `${label} must be a whole number`;
  const n = Number(s);
  if (n < 1) return `${label} must be at least 1`;
  if (n > max) return `${label} cannot be more than ${max}`;
  return null;
}

// The five fields an operator fills in, in grid order:
// Vendor, Article, Pack Size, Floor, Number of Barcodes.
function batchFieldsError(f) {
  const v = f || {};
  return pickError(v.outbound_vendor_id, 'Vendor')
    || pickError(v.article_id, 'Article')
    || wholeNumberError(v.pack_size, 'Pack Size', PACK_SIZE_MAX)
    || pickError(v.floor_id, 'Floor')
    || wholeNumberError(v.label_count, 'Number of Barcodes', LABEL_COUNT_MAX);
}

const normOperator = (v) => (v == null ? '' : String(v).trim().replace(/\s+/g, ' '));

// Nobody signs in at the station, so every write names the person at the PC.
function operatorError(value) {
  const name = normOperator(value);
  if (!name) return 'Operator name is required';
  if (name.length > OPERATOR_MAX) return `Operator name cannot be longer than ${OPERATOR_MAX} characters`;
  return null;
}

function keyError(value) {
  if (isBlank(value)) return 'Key is required';
  if (!KEY_RE.test(String(value).trim())) return 'Key must be 8 digits';
  return null;
}

function pinError(value) {
  if (isBlank(value)) return 'PIN is required';
  if (!PIN_RE.test(String(value).trim())) return 'PIN must be 4 to 8 digits';
  return null;
}

function labelSizeError(width, height) {
  const range = (v, label, min, max) => {
    if (isBlank(v)) return `${label} is required`;
    const s = String(v).trim();
    if (!/^\d+$/.test(s) || Number(s) < min || Number(s) > max) return `${label} must be a whole number of mm from ${min} to ${max}`;
    return null;
  };
  return range(width, 'Sticker width', LABEL_WIDTH_MIN, LABEL_WIDTH_MAX)
    || range(height, 'Sticker height', LABEL_HEIGHT_MIN, LABEL_HEIGHT_MAX);
}

module.exports = {
  KEY_MIN, KEY_MAX, KEY_RE, PACK_SIZE_MAX, LABEL_COUNT_MAX, OPERATOR_MAX, PIN_RE,
  LABEL_WIDTH_MIN, LABEL_WIDTH_MAX, LABEL_HEIGHT_MIN, LABEL_HEIGHT_MAX,
  wholeNumberError, batchFieldsError, normOperator, operatorError, keyError, pinError, labelSizeError,
};
