const db = require('../config/db');

// The Outbound Product List taxonomy, indexed for the callers that need to know
// which unit metrics a (Category, Item Name) pair is listed under.
//
// Since migration 064 the table is keyed on (category, item_name, unit_metric),
// so one pair can legitimately appear under several metrics -- "Barcode /
// Barcode" in pcs and in mtr was the case that motivated it. Three callers now
// need that index (packaging product onboarding, vendor article listing, PO line
// validation), so it lives here rather than being copied into each.

function normText(v) {
  return v == null ? '' : String(v).trim();
}

const pairKey = (c, i) => `${normText(c).toLowerCase()}|${normText(i).toLowerCase()}`;

// pairKey -> [row, ...] of active outbound products, ordered by metric so option
// lists and error messages are stable between calls.
async function loadOutboundProducts() {
  const { rows } = await db.execute(
    `SELECT category, item_name, unit_metric FROM outbound_products
     WHERE is_active = 1
     ORDER BY unit_metric COLLATE NOCASE`
  );
  const map = new Map();
  for (const r of rows) {
    const k = pairKey(r.category, r.item_name);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return map;
}

// pairKey -> [unit_metric, ...]. The metric strings only, for callers that just
// need the option list rather than the whole master row.
async function unitMetricsByPair() {
  const master = await loadOutboundProducts();
  const map = new Map();
  for (const [k, rows] of master) {
    map.set(k, [...new Set(rows.map(r => r.unit_metric).filter(Boolean))]);
  }
  return map;
}

module.exports = { pairKey, normText, loadOutboundProducts, unitMetricsByPair };
