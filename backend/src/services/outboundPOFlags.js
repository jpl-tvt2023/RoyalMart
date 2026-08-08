// Exception flags on outbound POs.
//
// Every flag is DERIVED at read time, never stored. The decisive reason is that
// rate_mismatch depends on outbound_po_lines.rate, which is mutated by the PO
// update endpoint -- a path that never touches receipts. A stored column would
// need invalidation across six separate write paths, one of which has no reason
// to know receipts exist, and that is exactly the shape of bug that produces
// silent drift on a production ERP. There is direct precedent: a line's
// `received` total is already a correlated subquery for the same reason.
//
// Each flag exposes BOTH a SQL predicate and an equivalent JS predicate. The
// SQL drives list filtering/sorting, the JS labels individual receipts on the
// detail page. They are deliberately duplicated, so a parity test pins them
// together.

// Half a paisa. Rates round-trip through SQLite REAL, so an exact !== would
// flag pairs that are equal for every practical purpose.
const RATE_EPSILON = 0.005;

const FLAGS = {
  rate_mismatch: {
    label: 'Rate Mismatch',
    short: 'Rate ≠',
    color: 'red',
    // Only meaningful when an agreed rate actually exists. outbound_po_lines.rate
    // is REAL NOT NULL DEFAULT 0, so "no agreed rate yet" is stored as 0 rather
    // than NULL -- hence the `> 0` guard rather than an IS NOT NULL check.
    // The received_rate IS NOT NULL test also excludes legacy receipts, which
    // predate billed rate being mandatory and have nothing to compare.
    sql: `r.received_rate IS NOT NULL AND l.rate > 0
          AND ABS(r.received_rate - l.rate) > ${RATE_EPSILON}`,
    js: (r, l) => r.received_rate != null && Number(l.rate) > 0
      && Math.abs(Number(r.received_rate) - Number(l.rate)) > RATE_EPSILON,
  },
  missing_incoming_no: {
    label: 'No Incoming No',
    short: 'No Inc No',
    color: 'yellow',
    sql: 'r.incoming_no IS NULL',
    js: (r) => r.incoming_no == null,
  },
};

const FLAG_KEYS = Object.keys(FLAGS);

// Correlates on the OUTER alias `p` (outbound_pos), for the list query.
const poFlagExists = (k) => `EXISTS (
  SELECT 1 FROM outbound_po_lines l
  JOIN outbound_po_line_receipts r ON r.line_id = l.id
  WHERE l.po_id = p.id AND l.deleted_at IS NULL AND r.deleted_at IS NULL
    AND (${FLAGS[k].sql}))`;

// Correlates on the OUTER alias `l` (outbound_po_lines), so l.rate resolves to
// the outer line -- which is exactly what rate_mismatch needs.
const lineFlagExists = (k) => `EXISTS (
  SELECT 1 FROM outbound_po_line_receipts r
  WHERE r.line_id = l.id AND r.deleted_at IS NULL AND (${FLAGS[k].sql}))`;

const receiptFlags = (receipt, line) => FLAG_KEYS.filter(k => FLAGS[k].js(receipt, line));

// The EXISTS columns come back as 0/1 -- collapse them into a key array.
const pickFlags = (row) => FLAG_KEYS.filter(k => row[`flag_${k}`]);

const flagSelect = (fn) => FLAG_KEYS.map(k => `${fn(k)} AS flag_${k}`).join(',\n');

module.exports = {
  FLAGS, FLAG_KEYS, RATE_EPSILON,
  poFlagExists, lineFlagExists, receiptFlags, pickFlags, flagSelect,
};
