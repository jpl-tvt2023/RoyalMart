const db = require('../config/db');

async function logAction({ client, userId, actionType, description, entityType, entityId }) {
  const executor = client || db;
  await executor.execute({
    sql: `INSERT INTO audit_logs (user_id, action_type, description, entity_type, entity_id)
          VALUES (?, ?, ?, ?, ?)`,
    args: [userId || null, actionType, description || null, entityType || null, entityId || null],
  });
}

module.exports = { logAction };
