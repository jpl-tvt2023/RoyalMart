// Client mirror of backend/src/services/stitching.service.js. The server is
// always the authority — these copies exist so the page can label a stage, show
// the next one, and pre-fill a rate without a round trip. Keep the two in step.

export const STAGES = ['Gray', 'Processed', 'Stitched', 'Packed'];

export const STATUSES = ['Pending', 'Partial', 'Forwarded', 'In Stock', 'Closed'];

// Outstanding work: still holding metre, or packed but not yet dispatched.
// Twin of OPEN_STATUSES in the backend service, keep the two in step.
export const OPEN_STATUSES = ['Pending', 'Partial', 'In Stock'];

export const STATUS_COLORS = {
  Pending: 'blue',
  Partial: 'yellow',
  Forwarded: 'green',
  'In Stock': 'purple',
  Closed: 'navy',
};

export const nextStage = (stage) => {
  const i = STAGES.indexOf(stage);
  return i === -1 ? null : (STAGES[i + 1] || null);
};

// Half a paisa / half a millimetre. Twin of EPSILON in the backend service.
export const EPSILON = 0.005;

// Mirrors moneyError/qtyError on the server, including the message text, so the
// user sees the same wording whichever side rejects the value. The 2dp check is
// a round-trip rather than a regex so it accepts 12, '12.5' and 12.50 alike, and
// the 1e-9 slack absorbs float error (0.29 * 100 is 28.999999999999996).
const has2dp = (n) => Math.abs(Math.round(n * 100) - n * 100) <= 1e-9;

export function moneyError(value, label, { required = false } = {}) {
  if (value == null || value === '') return required ? `${label} is required` : null;
  const n = Number(value);
  if (!Number.isFinite(n)) return `${label} must be a number`;
  if (n < 0) return `${label} must be a number >= 0`;
  if (!has2dp(n)) return `${label} can have at most 2 decimal places`;
  return null;
}

export function qtyError(value, label) {
  if (value == null || value === '') return `${label} is required`;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return `${label} must be a number > 0`;
  if (!has2dp(n)) return `${label} can have at most 2 decimal places`;
  return null;
}

// After Rate defaults to carried-in rate plus this stage's process rate, and
// stays on that default until the user types over it.
export const defaultAfterRate = (rate, processRate) => {
  const n = Number(rate || 0) + Number(processRate || 0);
  return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : '';
};

// Trailing zeros are noise in a table; 62.5 reads better than 62.50.
export const fmtNum = (v) => (v == null || v === '' ? '—' : String(Math.round(Number(v) * 100) / 100));

export const fullIncomingNo = (row) =>
  `${row.incoming_prefix || ''}${row.incoming_no || ''}` || null;
