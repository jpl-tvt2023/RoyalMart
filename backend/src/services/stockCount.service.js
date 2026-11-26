// Stock counts (migration 102): the status rules, in SQL only.
//
// Two things are stored -- counts (stock_counts) and the stickers scanned on
// each (stock_count_scans). Everything below is derived from them at read
// time, the house rule for anything derivable. There is deliberately NO JS
// twin, so no parity test: every list, total and page is computed in SQL.
//
// Only CLOSED counts decide anything. An open count is work in progress -- a
// pack it has not reached yet is not missing. Counts close in id order (the
// schema allows one open count at a time), so `seq` -- a closed count's
// position, 1 for Day 1 -- is ROW_NUMBER() OVER (ORDER BY id).
//
// Per sticker (label_key), from its sightings on closed counts:
//
//   in_stock     scanned on the latest closed count
//   out          last seen on count P, not on any later one. It went Out on
//                P + 1 -- at once, no waiting.
//   not_counted  never scanned on a closed count. NEVER Out: stock that has
//                not reached the shelf yet must not be marked Out.
//
// Per count C:
//   found        scanned on C
//   new          first ever sighting is on C
//   out          last seen on C - 1 and never since -- the FINAL figure. A pack
//                that comes back later moves from Out to missed, so a past
//                count's Out total corrects itself.
//   missed       seen before C, absent on C, seen again after C. A mistake by
//                the scanner. ADMIN/OWNER ONLY -- never in a station response
//                or an everyone-visible report.
//   flagged      scanned on C on a floor other than its sticker's.

const STATUS = { IN_STOCK: 'in_stock', OUT: 'out', NOT_COUNTED: 'not_counted' };

// India has no daylight saving, so a fixed offset turns a stored UTC datetime
// into the IST calendar day people saw. Shared with barcodeStation.controller.js.
const IST_DATE = (col) => `date(${col}, '+5 hours', '+30 minutes')`;

// Today in IST, as SQL.
const IST_TODAY = "date('now', '+5 hours', '+30 minutes')";

// The CTEs every report starts from. Use as `WITH ${STATE_CTES} SELECT ...`.
//   cc         closed counts with their seq
//   latest     the latest closed seq (0 before Day 1)
//   ks         each sighted key's first and last seq
//   kstate     EVERY key: status, first/last seq, the floor it was last seen
//              on, and its batch's article, floor, pack size
// cc and ks are read many times per query, so they are MATERIALIZED (computed
// once) rather than inlined at every reference.
const STATE_CTES = `
  cc AS MATERIALIZED (
    SELECT id, started_at, closed_at, started_by, closed_by,
           ROW_NUMBER() OVER (ORDER BY id) AS seq
      FROM stock_counts WHERE closed_at IS NOT NULL
  ),
  latest AS (SELECT COALESCE(MAX(seq), 0) AS seq FROM cc),
  ks AS MATERIALIZED (
    SELECT s.label_key, MIN(cc.seq) AS first_seq, MAX(cc.seq) AS last_seq
      FROM stock_count_scans s JOIN cc ON cc.id = s.count_id
     GROUP BY s.label_key
  ),
  kstate AS (
    SELECT k.label_key, k.batch_id, k.label_no,
           b.article_id, b.outbound_vendor_id, b.floor_id AS sticker_floor_id, b.pack_size,
           ks.first_seq, ks.last_seq,
           ls.floor_id AS seen_floor_id,
           CASE WHEN ks.label_key IS NULL THEN '${STATUS.NOT_COUNTED}'
                WHEN ks.last_seq = (SELECT seq FROM latest) THEN '${STATUS.IN_STOCK}'
                ELSE '${STATUS.OUT}' END AS status
      FROM label_keys k
      JOIN label_batches b ON b.id = k.batch_id
      LEFT JOIN ks ON ks.label_key = k.label_key
      LEFT JOIN cc lc ON lc.seq = ks.last_seq
      LEFT JOIN stock_count_scans ls ON ls.count_id = lc.id AND ls.label_key = k.label_key
  )`;

// Missed scans, one row per (key, closed count it was missed on). Append to
// STATE_CTES: `WITH ${STATE_CTES}, ${MISSED_CTES} ...`.
//   gaps     each sighting with the seq of the key's previous sighting
//   missed   the closed counts strictly between two sightings, with the count
//            the key turned up again on
const MISSED_CTES = `
  gaps AS (
    SELECT s.label_key, cc.seq, cc.id AS count_id,
           LAG(cc.seq) OVER (PARTITION BY s.label_key ORDER BY cc.seq) AS prev_seq
      FROM stock_count_scans s JOIN cc ON cc.id = s.count_id
  ),
  missed AS (
    SELECT g.label_key, m.id AS count_id, m.seq, g.count_id AS found_again_count_id
      FROM gaps g JOIN cc m ON m.seq > g.prev_seq AND m.seq < g.seq
     WHERE g.prev_seq IS NOT NULL AND g.seq - g.prev_seq > 1
  )`;

// Per closed count: found / new / out / flagged, as aggregates joined onto cc
// (one pass each, not a subquery per count -- counts pile up daily). Use after
// STATE_CTES. `missed` is NOT here -- it is Admin/Owner only, see MISSED_CTES.
// out: a key last seen on seq P went Out on P + 1, which only exists as a
// closed count once there is one after P.
const COUNT_TOTALS_SELECT = `
  SELECT cc.id, cc.seq, cc.started_at, cc.closed_at, cc.started_by, cc.closed_by,
         COALESCE(fd.n, 0) AS found, COALESCE(nw.n, 0) AS new_packs,
         COALESCE(ot.n, 0) AS out_packs, COALESCE(fl.n, 0) AS flagged
    FROM cc
    LEFT JOIN (SELECT count_id, COUNT(*) AS n FROM stock_count_scans GROUP BY count_id) fd ON fd.count_id = cc.id
    LEFT JOIN (SELECT first_seq AS seq, COUNT(*) AS n FROM ks GROUP BY first_seq) nw ON nw.seq = cc.seq
    LEFT JOIN (SELECT last_seq + 1 AS seq, COUNT(*) AS n FROM ks GROUP BY last_seq) ot ON ot.seq = cc.seq
    LEFT JOIN (SELECT s.count_id, COUNT(*) AS n
                 FROM stock_count_scans s
                 JOIN label_keys k ON k.label_key = s.label_key
                 JOIN label_batches b ON b.id = k.batch_id
                WHERE s.floor_id <> b.floor_id
                GROUP BY s.count_id) fl ON fl.count_id = cc.id`;

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
