// Display metadata for the outbound PO exception flags. The flags themselves
// are computed server-side (see backend/src/services/outboundPOFlags.js) and
// arrive as an array of keys on each PO, line, and receipt — this module only
// decides how they look.

export const FLAG_META = {
  rate_mismatch: {
    label: 'Rate Mismatch',
    short: 'Rate ≠',
    color: 'red',
    hint: 'The rate the vendor billed differs from the rate agreed on the PO line',
  },
  missing_incoming_no: {
    label: 'Missing Incoming No',
    short: 'Missing Inc No',
    color: 'yellow',
    hint: 'This receipt was saved without a warehouse incoming number',
  },
  // PO-level rather than receipt-level, so it never appears on a line or
  // receipt badge — only on the PO row.
  not_approved: {
    label: 'Not Approved',
    short: 'Not Appr',
    color: 'orange',
    hint: 'This PO has no Approved By value',
  },
};

export const FLAG_KEYS = Object.keys(FLAG_META);

// Filter options: every real flag, plus a pseudo-key for "clean POs only".
export const FLAG_FILTER_OPTIONS = [...FLAG_KEYS, 'none'];

export const flagLabel = (k) => (k === 'none' ? 'No flags' : FLAG_META[k]?.label || k);
