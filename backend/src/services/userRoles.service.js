const db = require('../config/db');

async function userQualifiesAs(userId, role) {
  if (userId == null) return true;
  const { rows } = await db.execute({
    sql: 'SELECT role FROM user_roles WHERE user_id = ?',
    args: [Number(userId)],
  });
  return rows.some(r => r.role === role || r.role === 'Admin' || r.role === 'Owner');
}

module.exports = { userQualifiesAs };
