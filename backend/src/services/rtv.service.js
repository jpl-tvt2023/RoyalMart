// RTV -- which marketplace POs are on the RTV page, and what status a row shows.
//
// Both are DERIVED, never stored, and both are needed twice: as SQL, so the
// page can filter and count in the database, and as JS, so a single row can be
// labelled (and the GRN page can tell whether a save takes a row off RTV). The
// twins are pinned by a parity test in tests/rtv.test.js -- change one half,
// change the other.

const RETURNED_TO_VENDOR = 'Returned to Vendor';

// The three statuses a user may pick on the RTV page (migration 092). 'RTV
// Booked' needs a credit note, 'DN - Disposed' clears everything after it.
const RTV_BOOKED = 'RTV Booked';
const DN_YES = 'DN - Yes';
const DN_DISPOSED = 'DN - Disposed';
const RTV_STATUSES = [RTV_BOOKED, DN_YES, DN_DISPOSED];

// The Status filter's "nobody has picked one yet" option -- an effective status
// of NULL. Spelled so it cannot collide with a real status.
const BLANK_STATUS = '__blank__';

const DELIVERED_VALUES = ['Yes', 'No'];

// A PO is on the RTV page while it is not Deleted and the GRN page says the
// goods came back: the whole shipment refused, or some of it short on receipt.
// Correlates on the alias `p` (marketplace_pos).
const QUALIFIES_SQL = `(p.status <> 'Deleted' AND (p.grn_status = '${RETURNED_TO_VENDOR}' OR COALESCE(p.discrepancy_qty, 0) > 0))`;

const rtvQualifies = (po) => po != null && po.status !== 'Deleted'
  && (po.grn_status === RETURNED_TO_VENDOR || Number(po.discrepancy_qty || 0) > 0);

// The row's DN: the GRN page's Discrepancy Number when there is one, else the
// one typed on the RTV page (a fully returned shipment's GRN DN is always
// cleared). Correlates on `p` and `r` (rtv_returns).
const DN_SQL = "COALESCE(NULLIF(TRIM(p.discrepancy_number), ''), NULLIF(TRIM(r.dn_number), ''))";

const blankText = (v) => v == null || String(v).trim() === '';
const dnOf = ({ grn_dn, dn_number }) => (!blankText(grn_dn) ? String(grn_dn).trim()
  : !blankText(dn_number) ? String(dn_number).trim() : null);

// What the Status column SHOWS: what a user picked, or -- until someone does --
// 'DN - Yes' on a row that has a DN, and blank on one that does not. Derived, so
// a DN entered later shows without anyone re-saving the row.
const EFFECTIVE_STATUS_SQL = `COALESCE(r.status, CASE WHEN ${DN_SQL} IS NOT NULL THEN '${DN_YES}' END)`;

const effectiveStatus = ({ status, grn_dn, dn_number }) => status || (dnOf({ grn_dn, dn_number }) ? DN_YES : null);

module.exports = {
  RETURNED_TO_VENDOR, RTV_BOOKED, DN_YES, DN_DISPOSED, RTV_STATUSES, BLANK_STATUS, DELIVERED_VALUES,
  QUALIFIES_SQL, DN_SQL, EFFECTIVE_STATUS_SQL, rtvQualifies, effectiveStatus, dnOf,
};
