const db = require('../config/db');

// GET /api/audit-logs?entity_type=marketplace_pos&entity_id=RM-001
// Returns the change history for a single record, newest first.
async function getEntityHistory(req, res) {
  const entityType = req.query.entity_type;
  const entityId = req.query.entity_id;
  if (!entityType || entityId == null || entityId === '') {
    return res.status(400).json({ message: 'entity_type and entity_id are required' });
  }

  // entity_id may be numeric (most tables) or textual (marketplace_pos.po_id),
  // so match against both the INTEGER entity_id and the TEXT entity_ref.
  const key = String(entityId);
  const { rows } = await db.execute({
    sql: `SELECT a.id, a.action_type, a.description, a.entity_type, a.entity_id,
                 a.entity_ref, a.changes, a.timestamp, a.user_id, u.name AS user_name
          FROM audit_logs a
          LEFT JOIN users u ON u.id = a.user_id
          WHERE a.entity_type = ?
            AND (CAST(a.entity_id AS TEXT) = ? OR a.entity_ref = ?)
          ORDER BY a.timestamp DESC, a.id DESC`,
    args: [String(entityType), key, key],
  });

  const history = rows.map(r => ({
    ...r,
    changes: r.changes ? JSON.parse(r.changes) : [],
  }));
  res.json(history);
}

module.exports = { getEntityHistory };
