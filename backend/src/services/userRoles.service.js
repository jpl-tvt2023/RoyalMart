const db = require('../config/db');

async function userQualifiesAs(userId, role) {
  if (userId == null) return true;
  const { rows } = await db.execute({
    sql: 'SELECT role FROM user_roles WHERE user_id = ?',
    args: [Number(userId)],
  });
  return rows.some(r => r.role === role || r.role === 'Admin' || r.role === 'Owner');
}

// Strict membership: the user must hold the exact role. Admin/Owner are NOT
// treated as implicitly qualifying (used for POC assignment, which is tag-based).
async function userHasRole(userId, role) {
  if (userId == null) return true; // null = unassigning, allowed
  const { rows } = await db.execute({
    sql: 'SELECT 1 FROM user_roles WHERE user_id = ? AND role = ?',
    args: [Number(userId), role],
  });
  return rows.length > 0;
}

module.exports = { userQualifiesAs, userHasRole };
