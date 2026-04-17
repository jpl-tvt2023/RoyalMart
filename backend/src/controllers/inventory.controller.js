const db = require('../config/db');

async function list(req, res, next) {
  try {
    const { rows } = await db.execute(`
      SELECT
        p.id AS sku_id,
        p.sku_code,
        p.name,
        p.color,
        p.fabric_type,
        p.gsm,
        p.safety_threshold,
        i.on_hand_qty,
        i.in_transit_qty,
        i.committed_qty,
        i.updated_at,
        (i.on_hand_qty + i.in_transit_qty - i.committed_qty) AS net_position,
        CASE WHEN (i.on_hand_qty + i.in_transit_qty - i.committed_qty) < p.safety_threshold
             THEN 1 ELSE 0 END AS is_critical
      FROM products p
      JOIN inventory i ON i.sku_id = p.id
      ORDER BY is_critical DESC, p.sku_code
    `);
    res.json(rows.map(r => ({ ...r, is_critical: !!r.is_critical })));
  } catch (err) { next(err); }
}

async function auditHistory(req, res, next) {
  try {
    const { skuId } = req.params;
    const { rows } = await db.execute({
      sql: `SELECT al.id, al.action_type, al.description, al.timestamp,
                   u.name AS user_name
            FROM audit_logs al
            LEFT JOIN users u ON u.id = al.user_id
            WHERE al.entity_type = 'inventory' AND al.entity_id = ?
            ORDER BY al.timestamp DESC
            LIMIT 50`,
      args: [skuId],
    });
    res.json(rows);
  } catch (err) { next(err); }
}

module.exports = { list, auditHistory };
