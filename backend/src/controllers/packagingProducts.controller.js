const db = require('../config/db');

// Read-only rollup: every unique (category, item_name) combination currently
// mapped to at least one outbound vendor, with a count of how many vendors
// use it. There's no dedicated table for this — it's always computed live
// from outbound_vendor_articles so it can never drift out of sync.
async function list(req, res, next) {
  try {
    const { rows } = await db.execute(`
      SELECT category, item_name, COUNT(DISTINCT vendor_id) AS vendor_count
      FROM outbound_vendor_articles
      GROUP BY category, item_name
      ORDER BY category ASC, item_name ASC
    `);
    res.json(rows);
  } catch (err) { next(err); }
}

module.exports = { list };
