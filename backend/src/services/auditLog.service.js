const pool = require('../config/db');

async function logAction({ client, userId, actionType, description, entityType, entityId }) {
  const db = client || pool;
  await db.query(
    `INSERT INTO audit_logs (user_id, action_type, description, entity_type, entity_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId || null, actionType, description || null, entityType || null, entityId || null]
  );
}

module.exports = { logAction };
