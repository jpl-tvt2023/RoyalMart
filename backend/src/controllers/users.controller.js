const bcrypt = require('bcryptjs');
const db = require('../config/db');
const { logAction, diffFields } = require('../services/auditLog.service');
const { validatePassword } = require('../services/passwordPolicy');
const { ALL_ROLES } = require('../middleware/rbac');

const BCRYPT_COST = 12;
const VALID_ROLES = ALL_ROLES;

function coerceUser(row) {
  return { ...row, is_first_login: !!row.is_first_login };
}

function validateRoles(input) {
  if (!Array.isArray(input) || input.length === 0) return 'At least one role is required';
  const bad = input.find(r => !VALID_ROLES.includes(r));
  if (bad) return `Invalid role: ${bad}`;
  return null;
}

async function replaceRoles(userId, roles) {
  await db.execute({ sql: 'DELETE FROM user_roles WHERE user_id = ?', args: [userId] });
  const unique = [...new Set(roles)];
  for (const role of unique) {
    await db.execute({
      sql: 'INSERT INTO user_roles (user_id, role) VALUES (?, ?)',
      args: [userId, role],
    });
  }
}

async function fetchRolesMap(userIds) {
  if (!userIds.length) return new Map();
  const placeholders = userIds.map(() => '?').join(',');
  const { rows } = await db.execute({
    sql: `SELECT user_id, role FROM user_roles WHERE user_id IN (${placeholders}) ORDER BY role`,
    args: userIds,
  });
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.user_id)) map.set(r.user_id, []);
    map.get(r.user_id).push(r.role);
  }
  return map;
}

async function list(req, res, next) {
  try {
    const { rows } = await db.execute(
      `SELECT u.id, u.name, u.email, u.is_first_login, u.created_at, u.updated_at,
              eu.name AS updated_by_name
       FROM users u
       LEFT JOIN users eu ON eu.id = u.updated_by
       ORDER BY u.created_at DESC`
    );
    const rolesMap = await fetchRolesMap(rows.map(r => r.id));
    res.json(rows.map(r => ({ ...coerceUser(r), roles: rolesMap.get(r.id) || [] })));
  } catch (err) { next(err); }
}

async function create(req, res, next) {
  try {
    const { name, email, roles, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ message: 'name, email, and password are required' });
    }
    const rolesErr = validateRoles(roles);
    if (rolesErr) return res.status(400).json({ message: rolesErr });

    const policyError = await validatePassword(password);
    if (policyError) return res.status(400).json({ message: policyError });

    const hash = await bcrypt.hash(password, BCRYPT_COST);
    const { rows } = await db.execute({
      sql: `INSERT INTO users (name, email, password_hash, is_first_login)
            VALUES (?,?,?,1) RETURNING id, name, email, is_first_login, created_at`,
      args: [name, email, hash],
    });
    const userId = rows[0].id;
    await replaceRoles(userId, roles);

    await logAction({ userId: req.user.id, actionType: 'USER_CREATE', description: `Created user ${email} (${roles.join(',')})`, entityType: 'user', entityId: userId });
    res.status(201).json({ ...coerceUser(rows[0]), roles: [...new Set(roles)] });
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ message: 'Email already exists' });
    }
    next(err);
  }
}

async function update(req, res, next) {
  try {
    const { id } = req.params;
    const { name, roles } = req.body;
    if (!name && !roles) return res.status(400).json({ message: 'Nothing to update' });

    const { rows: before } = await db.execute({
      sql: 'SELECT id, name, email, is_first_login FROM users WHERE id = ?',
      args: [id],
    });
    if (!before.length) return res.status(404).json({ message: 'User not found' });
    const prevRoles = (await fetchRolesMap([before[0].id])).get(before[0].id) || [];

    const { rows } = await db.execute({
      sql: `UPDATE users SET name = COALESCE(?, name), updated_by = ?, updated_at = datetime('now')
            WHERE id = ? RETURNING id, name, email, is_first_login`,
      args: [name || null, req.user.id, id],
    });
    const userRow = rows[0];

    if (roles !== undefined) {
      const rolesErr = validateRoles(roles);
      if (rolesErr) return res.status(400).json({ message: rolesErr });
      await replaceRoles(userRow.id, roles);
    }

    const rolesMap = await fetchRolesMap([userRow.id]);
    const finalRoles = rolesMap.get(userRow.id) || [];

    const changes = diffFields(
      { name: before[0].name, roles: prevRoles.join(', ') },
      { name: userRow.name, roles: finalRoles.join(', ') },
      ['name', 'roles'],
    );
    await logAction({ userId: req.user.id, actionType: 'USER_UPDATE', description: `Updated user ${userRow.email} (${finalRoles.join(',')})`, entityType: 'user', entityId: userRow.id, changes });
    res.json({ ...coerceUser(userRow), roles: finalRoles });
  } catch (err) { next(err); }
}

async function remove(req, res, next) {
  try {
    const { id } = req.params;
    if (parseInt(id) === req.user.id) {
      return res.status(400).json({ message: 'Cannot delete your own account' });
    }

    // supplier_pos was dropped in migration 022; only marketplace POs link to users now.
    const { rows: poRows } = await db.execute({
      sql: 'SELECT COUNT(*) AS c FROM marketplace_pos WHERE created_by = ? OR onboarded_by = ? OR updated_by = ?',
      args: [id, id, id],
    });
    const poCount = poRows[0].c;
    if (poCount > 0) {
      return res.status(409).json({
        message: `Cannot delete: user is linked to ${poCount} purchase order${poCount !== 1 ? 's' : ''}. Reassign those records first.`,
      });
    }

    const { rows } = await db.execute({ sql: 'DELETE FROM users WHERE id = ? RETURNING email', args: [id] });
    if (!rows.length) return res.status(404).json({ message: 'User not found' });
    await logAction({ userId: req.user.id, actionType: 'USER_DELETE', description: `Deleted user ${rows[0].email}`, entityType: 'user', entityId: id });
    res.json({ message: 'User deleted' });
  } catch (err) { next(err); }
}

async function adminResetPassword(req, res, next) {
  try {
    const { id } = req.params;
    const { newPassword } = req.body;
    const policyError = await validatePassword(newPassword);
    if (policyError) return res.status(400).json({ message: policyError });
    const hash = await bcrypt.hash(newPassword, BCRYPT_COST);
    // Also clear MFA so a user who lost their authenticator can recover via admin reset.
    const { rows } = await db.execute({
      sql: 'UPDATE users SET password_hash = ?, is_first_login = 1, mfa_enabled = 0, mfa_secret = NULL WHERE id = ? RETURNING email',
      args: [hash, id],
    });
    if (!rows.length) return res.status(404).json({ message: 'User not found' });
    await logAction({ userId: req.user.id, actionType: 'PASSWORD_RESET', description: `Admin reset password for ${rows[0].email}`, entityType: 'user', entityId: id });
    res.json({ message: 'Password reset. User will be prompted to change on next login.' });
  } catch (err) { next(err); }
}

module.exports = { list, create, update, remove, adminResetPassword };
