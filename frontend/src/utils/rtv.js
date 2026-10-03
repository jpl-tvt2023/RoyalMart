// Client mirror of backend/src/services/rtv.service.js (migration 092). The
// server is the authority -- these copies exist so the GRN page can warn before
// a save takes a row off the RTV page, and the RTV page can check a row before
// a round trip. Keep the two in step, message text included.

export const RETURNED_TO_VENDOR = 'Returned to Vendor';

export const RTV_BOOKED = 'RTV Booked';
export const DN_YES = 'DN - Yes';
export const DN_DISPOSED = 'DN - Disposed';
export const RTV_STATUSES = [RTV_BOOKED, DN_YES, DN_DISPOSED];

// The Status filter's "nobody has picked one yet". Twin of BLANK_STATUS.
export const BLANK_STATUS = '__blank__';

export const DELIVERED_VALUES = ['Yes', 'No'];

export const STATUS_COLORS = {
  [RTV_BOOKED]: 'green',
  [DN_YES]: 'blue',
  [DN_DISPOSED]: 'gray',
};

// Twin of rtvQualifies: a PO is on the RTV page while it is not Deleted and the
// GRN page says the goods came back -- refused whole, or short on receipt.
export const rtvQualifies = (po) => po != null && po.status !== 'Deleted'
  && (po.grn_status === RETURNED_TO_VENDOR || Number(po.discrepancy_qty || 0) > 0);

// The columns after Status, which DN - Disposed clears. Twin of AFTER_STATUS.
export const AFTER_STATUS = ['inward_courier_id', 'inward_tracking_id', 'delivered', 'delivery_date',
  'cn_number', 'cn_date', 'checked_by'];

const ALNUM = /^[A-Za-z0-9-]+$/;
const TEXT_MAX = 50;
const blank = (v) => v == null || String(v).trim() === '';

const refError = (value, label) => {
  if (blank(value)) return null;
  const s = String(value).trim();
  if (!ALNUM.test(s)) return `${label} must be alphanumeric (dashes allowed)`;
  if (s.length > TEXT_MAX) return `${label} must be ${TEXT_MAX} characters or less`;
  return null;
};

// Mirrors the server's PATCH rules, in column order, so the first message here
// is the one the server would return. `row` is the merged row as it will save.
export function rtvRowError(row) {
  const dnErr = refError(row.dn_number, 'RTV / DN');
  if (dnErr) return dnErr;
  const trkErr = refError(row.inward_tracking_id, 'Inward Tracking ID');
  if (trkErr) return trkErr;
  const cnErr = refError(row.cn_number, 'Credit Note Number');
  if (cnErr) return cnErr;
  if (row.status === DN_DISPOSED) return null;
  if (row.delivered === 'Yes' && blank(row.delivery_date)) return 'Delivery Date is required when Delivered is Yes';
  if (row.status === RTV_BOOKED && blank(row.cn_number)) return 'Credit Note Number is required when the status is RTV Booked';
  if (!blank(row.cn_number) && blank(row.cn_date)) return 'CN Date is required when a Credit Note Number is entered';
  return null;
}
