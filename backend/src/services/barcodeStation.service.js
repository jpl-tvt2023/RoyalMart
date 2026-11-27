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

// How the station prints (migration 100), set by Admin/Owner:
//   dialog -- through the browser's print dialog (which shows its own preview)
//   direct -- for PCs whose Chrome/Edge runs with --kiosk-printing: no dialog,
//             no preview, the job goes straight to the default printer
const PRINT_MODES = ['dialog', 'direct'];

// The shared station PIN: numeric, 4 to 8 digits (client's choice). Short PINs
// are why the server also keeps a database-backed, escalating lockout.
const PIN_RE = /^\d{4,8}$/;

// The sticker the print sheet is laid out at, in mm with at most one decimal
// (104 -- the client's roll is 150 x 48.2).
const LABEL_WIDTH_MIN = 20;
const LABEL_WIDTH_MAX = 300;
const LABEL_HEIGHT_MIN = 10;
const LABEL_HEIGHT_MAX = 300;

// How stickers share one printed page (104), as in the client's BarTender
// template: N stacked per page, a gap between them, a blank strip above the
// first and below the last. The page height is derived (labelPageHeight) and
// may be no taller than LABEL_HEIGHT_MAX.
const LABELS_PER_PAGE_MAX = 4;
const LABEL_GAP_MAX = 20;
const PAGE_MARGIN_MAX = 20;

const MM_RE = /^\d+(\.\d)?$/;

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

function printModeError(value) {
  return PRINT_MODES.includes(value) ? null : 'Print mode must be dialog or direct';
}

function keyError(value) {
  if (isBlank(value)) return 'Key is required';
  if (!KEY_RE.test(String(value).trim())) return 'Key must be 8 digits';
  return null;
}

// Stock counts (migration 102): the station sends scans in small groups, so a
// queue that built up while the Wi-Fi was down drains in a few requests.
const SCAN_BATCH_MAX = 200;

function scanBatchError(keys) {
  if (!Array.isArray(keys) || keys.length === 0) return 'Scan at least one key';
  if (keys.length > SCAN_BATCH_MAX) return `Send at most ${SCAN_BATCH_MAX} keys at a time`;
  if (keys.some((k) => keyError(k))) return 'Every key must be 8 digits';
  return null;
}

// One scan request: the floor the scanner is on, then the keys.
function scanFieldsError(f) {
  const v = f || {};
  return pickError(v.floor_id, 'Floor') || scanBatchError(v.keys);
}

function pinError(value) {
  if (isBlank(value)) return 'PIN is required';
  if (!PIN_RE.test(String(value).trim())) return 'PIN must be 4 to 8 digits';
  return null;
}

// A length in mm, at most one decimal, from min to max.
function mmError(v, label, min, max) {
  if (isBlank(v)) return `${label} is required`;
  const s = String(v).trim();
  if (!MM_RE.test(s) || Number(s) < min || Number(s) > max) return `${label} must be from ${min} to ${max} mm, at most one decimal`;
  return null;
}

function labelSizeError(width, height) {
  return mmError(width, 'Sticker width', LABEL_WIDTH_MIN, LABEL_WIDTH_MAX)
    || mmError(height, 'Sticker height', LABEL_HEIGHT_MIN, LABEL_HEIGHT_MAX);
}

// The printed page: n stickers of heightMm, gapMm apart, marginMm above the
// first and below the last. Rounded to 0.1 mm, so 2 x 48.2 + 4 + 2 x 1.3 is
// exactly 103, not 103.00000000000001.
function labelPageHeight(heightMm, perPage, gapMm, marginMm) {
  const n = Number(perPage) || 1;
  const h = 2 * (Number(marginMm) || 0) + n * Number(heightMm) + (n - 1) * (Number(gapMm) || 0);
  return Math.round(h * 10) / 10;
}

// Stickers per page, gap, margin -- the order the Label page form shows them --
// then the page they make, which must fit the same bound as a sticker.
function labelPageError(perPage, gapMm, marginMm, heightMm) {
  const err = wholeNumberError(perPage, 'Stickers per page', LABELS_PER_PAGE_MAX)
    || mmError(gapMm, 'Gap between stickers', 0, LABEL_GAP_MAX)
    || mmError(marginMm, 'Top and bottom margin', 0, PAGE_MARGIN_MAX);
  if (err) return err;
  if (labelPageHeight(heightMm, perPage, gapMm, marginMm) > LABEL_HEIGHT_MAX) {
    return `The page cannot be taller than ${LABEL_HEIGHT_MAX} mm`;
  }
  return null;
}

module.exports = {
  KEY_MIN, KEY_MAX, KEY_RE, PACK_SIZE_MAX, LABEL_COUNT_MAX, OPERATOR_MAX, PRINT_MODES, PIN_RE,
  LABEL_WIDTH_MIN, LABEL_WIDTH_MAX, LABEL_HEIGHT_MIN, LABEL_HEIGHT_MAX, SCAN_BATCH_MAX,
  LABELS_PER_PAGE_MAX, LABEL_GAP_MAX, PAGE_MARGIN_MAX,
  wholeNumberError, batchFieldsError, normOperator, operatorError, printModeError, keyError, pinError, labelSizeError,
  labelPageHeight, labelPageError,
  scanBatchError, scanFieldsError,
};
