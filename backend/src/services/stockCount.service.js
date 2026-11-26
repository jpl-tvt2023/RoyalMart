// Stock counts (migrations 102, 103): the status rules, in SQL only.
//
// Two things are stored -- counts (stock_counts, one per IST day that has a
// scan) and the stickers scanned on each (stock_count_scans). Everything below
// is derived from them at read time, the house rule for anything derivable.
// There is deliberately NO JS twin, so no parity test: every list, total and
// page is computed in SQL.
//
// THE COUNT IS THE DAY (103). There is no Start and no Close: the day's first
// scan creates its count, every scan that day joins it, and at midnight IST it
// is FINISHED -- a count is finished when its count_date is before today. Every
// day with a scan is a full count (the client's choice, no exceptions).
//
// `seq` is a day's position among all counts, by date. Today, if it has scans,
// is always the newest row, so its seq is the last. `latest` is the newest
// FINISHED seq (0 before Day 1 has finished).
//
// Per sticker (label_key), from its sightings on EVERY day, today's included:
//
//   in_stock     seen on the latest finished day, or today. A pack scanned
//                today is In Stock at once -- evening deliveries too.
//   out          last seen before the latest finished day. It went Out on the
//                finished day after its last sighting -- at once, no waiting.
//   not_counted  never scanned. NEVER Out: stock that has not reached the shelf
//                yet must not be marked Out.
//
// Per day C (finished, or today in progress):
//   found        scanned on C
//   new          first ever sighting is on C
//   out          FINISHED days only: last seen on C - 1 and never since -- the
//                FINAL figure. A pack that comes back later moves from Out to
//                missed, so a past day's Out total corrects itself. Today has
//                none until it finishes.
//   missed       seen before C, absent on C, seen again after C. A mistake by
//                the scanner (or a short day). ADMIN/OWNER ONLY -- never in a
//                station response or an everyone-visible report. Always a
//                finished day: the days between two sightings are all before
//                today.
//   flagged      scanned on C on a floor other than its sticker's.

const STATUS = { IN_STOCK: 'in_stock', OUT: 'out', NOT_COUNTED: 'not_counted' };

// India has no daylight saving, so a fixed offset turns a stored UTC datetime
// into the IST calendar day people saw. Shared with barcodeStation.controller.js.
const IST_DATE = (col) => `date(${col}, '+5 hours', '+30 minutes')`;

// Today in IST, as SQL -- the day a scan is counted on, and the line between
// finished counts and today's.
const IST_TODAY = "date('now', '+5 hours', '+30 minutes')";

// The CTEs every report starts from. Use as `WITH ${STATE_CTES} SELECT ...`.
//   days       every count (one per IST day) with its seq and `finished`
//   cc         the finished counts -- the only ones that decide Out
//   latest     the latest finished seq (0 before Day 1 has finished)
//   ks         each sighted key's first and last seq, today's scans included
//   kstate     EVERY key: status, first/last seq, the floor it was last seen
//              on, and its batch's article, floor, pack size
// days, cc and ks are read many times per query, so they are MATERIALIZED
// (computed once) rather than inlined at every reference.
const STATE_CTES = `
  days AS MATERIALIZED (
    SELECT id, count_date, started_by, started_at,
           ROW_NUMBER() OVER (ORDER BY count_date) AS seq,
           (count_date < ${IST_TODAY}) AS finished
      FROM stock_counts
  ),
  cc AS MATERIALIZED (SELECT * FROM days WHERE finished),
  latest AS (SELECT COALESCE(MAX(seq), 0) AS seq FROM cc),
  ks AS MATERIALIZED (
    SELECT s.label_key, MIN(d.seq) AS first_seq, MAX(d.seq) AS last_seq
      FROM stock_count_scans s JOIN days d ON d.id = s.count_id
     GROUP BY s.label_key
  ),
  kstate AS (
    SELECT k.label_key, k.batch_id, k.label_no,
           b.article_id, b.outbound_vendor_id, b.floor_id AS sticker_floor_id, b.pack_size,
           ks.first_seq, ks.last_seq,
           ls.floor_id AS seen_floor_id,
           CASE WHEN ks.label_key IS NULL THEN '${STATUS.NOT_COUNTED}'
                WHEN ks.last_seq >= (SELECT seq FROM latest) THEN '${STATUS.IN_STOCK}'
                ELSE '${STATUS.OUT}' END AS status
      FROM label_keys k
      JOIN label_batches b ON b.id = k.batch_id
      LEFT JOIN ks ON ks.label_key = k.label_key
      LEFT JOIN days lc ON lc.seq = ks.last_seq
      LEFT JOIN stock_count_scans ls ON ls.count_id = lc.id AND ls.label_key = k.label_key
  )`;

// Missed scans, one row per (key, finished day it was missed on). Append to
// STATE_CTES: `WITH ${STATE_CTES}, ${MISSED_CTES} ...`.
//   gaps     each sighting (today's included) with the seq of the key's
//            previous sighting
//   missed   the days strictly between two sightings -- always finished -- with
//            the day the key turned up again on
const MISSED_CTES = `
  gaps AS (
    SELECT s.label_key, d.seq, d.id AS count_id,
           LAG(d.seq) OVER (PARTITION BY s.label_key ORDER BY d.seq) AS prev_seq
      FROM stock_count_scans s JOIN days d ON d.id = s.count_id
  ),
  missed AS (
    SELECT g.label_key, m.id AS count_id, m.seq, g.count_id AS found_again_count_id
      FROM gaps g JOIN cc m ON m.seq > g.prev_seq AND m.seq < g.seq
     WHERE g.prev_seq IS NOT NULL AND g.seq - g.prev_seq > 1
  )`;

// Per day: found / new / out / flagged, as aggregates joined onto days (one
// pass each, not a subquery per day -- counts pile up daily). Use after
// STATE_CTES. `missed` is NOT here -- it is Admin/Owner only, see MISSED_CTES.
// out: a key last seen on seq P went Out on P + 1, and only once P + 1 is a
// finished day -- today's out_packs is NULL, not 0.
const COUNT_TOTALS_SELECT = `
  SELECT d.id, d.seq, d.count_date, d.started_by, d.started_at, d.finished,
         COALESCE(fd.n, 0) AS found, COALESCE(nw.n, 0) AS new_packs,
         CASE WHEN d.finished THEN COALESCE(ot.n, 0) END AS out_packs, COALESCE(fl.n, 0) AS flagged
    FROM days d
    LEFT JOIN (SELECT count_id, COUNT(*) AS n FROM stock_count_scans GROUP BY count_id) fd ON fd.count_id = d.id
    LEFT JOIN (SELECT first_seq AS seq, COUNT(*) AS n FROM ks GROUP BY first_seq) nw ON nw.seq = d.seq
    LEFT JOIN (SELECT last_seq + 1 AS seq, COUNT(*) AS n FROM ks GROUP BY last_seq) ot ON ot.seq = d.seq
    LEFT JOIN (SELECT s.count_id, COUNT(*) AS n
                 FROM stock_count_scans s
                 JOIN label_keys k ON k.label_key = s.label_key
                 JOIN label_batches b ON b.id = k.batch_id
                WHERE s.floor_id <> b.floor_id
                GROUP BY s.count_id) fl ON fl.count_id = d.id`;

// Expected use of an article by dispatches (the cross-check): every dispatched
// PO line, through the vendor's item code to our SKU, times how many of the
// article one unit of that SKU uses -- the join procurement.controller.js
// #getOutboundRequirements uses for outbound demand, over both usage tables.
// Takes ? from, ? to (IST dates, dispatch_date's own format).
const EXPECTED_USE_SQL = `
  SELECT r.packaging_raw_material_id AS article_id, SUM(l.qty * r.qty) AS expected_pcs
    FROM marketplace_pos po
    JOIN marketplace_po_lines l   ON l.po_id = po.po_id
    JOIN product_vendor_codes pvc ON pvc.vendor = po.vendor AND pvc.vendor_item_code = l.item_code
    JOIN (SELECT product_id, packaging_raw_material_id, qty FROM product_packaging_requirements
          UNION ALL
          SELECT product_id, packaging_raw_material_id, qty FROM product_barcode_requirements) r
      ON r.product_id = pvc.product_id
   WHERE po.status <> 'Deleted' AND po.dispatch_date IS NOT NULL
     AND po.dispatch_date >= ? AND po.dispatch_date <= ?
   GROUP BY r.packaging_raw_material_id`;

// Dispatched lines in the window that reach no usage at all (no item-code
// mapping, or a SKU with no packaging/barcode rows) -- the cross-check's
// expected figures are low by however much these lines used. ? from, ? to.
const UNLINKED_LINES_SQL = `
  SELECT COUNT(*) AS n
    FROM marketplace_pos po
    JOIN marketplace_po_lines l ON l.po_id = po.po_id
    LEFT JOIN product_vendor_codes pvc ON pvc.vendor = po.vendor AND pvc.vendor_item_code = l.item_code
   WHERE po.status <> 'Deleted' AND po.dispatch_date IS NOT NULL
     AND po.dispatch_date >= ? AND po.dispatch_date <= ?
     AND NOT EXISTS (SELECT 1 FROM product_packaging_requirements r WHERE r.product_id = pvc.product_id)
     AND NOT EXISTS (SELECT 1 FROM product_barcode_requirements r WHERE r.product_id = pvc.product_id)`;

module.exports = {
  STATUS, IST_DATE, IST_TODAY,
  STATE_CTES, MISSED_CTES, COUNT_TOTALS_SELECT, EXPECTED_USE_SQL, UNLINKED_LINES_SQL,
};
