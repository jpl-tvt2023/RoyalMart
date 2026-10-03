-- RTV: goods coming back from a marketplace, tracked to the credit note.
--
-- A marketplace PO comes back to us one of two ways, both recorded on the GRN
-- page: the whole shipment is refused (grn_status 'Returned to Vendor' -- the
-- vendor being US, from the marketplace's side), or part of it is short or
-- damaged on receipt (discrepancy_qty > 0, with a Discrepancy Number). Either
-- way the goods are owed back, or a credit note is owed instead, and until now
-- nothing tracked that. The client asked for a page that does.
--
-- WHICH POs ARE ON THE PAGE IS DERIVED, never stored. A PO qualifies while it
-- is not Deleted and either condition above holds -- the rtv controller and the
-- order-summary list share one SQL expression for it. This table holds only
-- what the RTV page itself owns: the RTV number and the fields a user types
-- there. Everything else on a row (Internal PO, DN, outward tracking, courier,
-- bill no, PO qty, city) is read LIVE off marketplace_pos, so a correction on
-- the GRN or Builty page shows here at once with no copy to keep in step.
--
-- ONE ROW PER PO, created the first time the PO qualifies (by the GRN save, in
-- its own transaction) and NEVER deleted. A PO that stops qualifying -- its
-- status changed, its discrepancy cleared, the PO deleted -- simply drops off
-- the page. The row and everything typed on it stay, so if the PO qualifies
-- again it comes back with the same RTV number and the same details. The GRN
-- page warns before a save that takes a row off.
--
-- RTV NO is <first letter of the vendor>R<serial, three digits>: BR001 for the
-- first Blinkit return, FR001 for Flipkart, the way a PO id is B001. The serial
-- runs per LETTER rather than per vendor name, so two vendors sharing a first
-- letter (an inactive 'flipkart now' exists) can never mint the same number.
-- Assigned once, never reused.
--
-- dn_number is the Discrepancy Number for a 'Returned to Vendor' row only. The
-- GRN page clears its own DN whenever the status is not 'Delivered - GRN
-- Received', so a fully returned shipment has nowhere else to record one. The
-- page shows the GRN page's DN when there is one, this when there is not.
--
-- status is what a user picked: 'RTV Booked', 'DN - Yes' or 'DN - Disposed'.
-- NULL means nobody has picked yet, and the page then SHOWS 'DN - Yes' when the
-- row has a DN and blank when it does not -- derived at read time, so it
-- follows a DN entered later without anyone re-saving the row.
--
-- po_id references marketplace_pos with NO cascade on purpose. A PO is only
-- ever soft-deleted, and a future rebuild of marketplace_pos must carry this
-- table across (detach and reattach, see 081) rather than silently wiping it
-- the way a cascade wiped marketplace_po_lines once.
--
-- No semicolons may appear in these comments -- migrate.js splits on them.

CREATE TABLE rtv_returns (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  po_id               TEXT NOT NULL UNIQUE REFERENCES marketplace_pos(po_id),
  rtv_no              TEXT NOT NULL UNIQUE,
  dn_number           TEXT,
  status              TEXT CHECK (status IN ('RTV Booked', 'DN - Yes', 'DN - Disposed')),
  inward_courier_id   INTEGER REFERENCES couriers(id),
  inward_tracking_id  TEXT,
  delivered           TEXT CHECK (delivered IN ('Yes', 'No')),
  delivery_date       TEXT,
  cn_number           TEXT,
  cn_date             TEXT,
  checked_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Every PO that qualifies today, numbered per letter in the order its GRN was
-- recorded. created_by stays NULL: the migration did it.
INSERT INTO rtv_returns (po_id, rtv_no)
SELECT p.po_id,
       UPPER(SUBSTR(p.vendor, 1, 1)) || 'R' || printf('%03d', ROW_NUMBER() OVER (
         PARTITION BY UPPER(SUBSTR(p.vendor, 1, 1))
         ORDER BY COALESCE(p.grn_date, p.updated_at), p.po_id
       ))
  FROM marketplace_pos p
 WHERE p.status <> 'Deleted'
   AND (p.grn_status = 'Returned to Vendor' OR COALESCE(p.discrepancy_qty, 0) > 0);
