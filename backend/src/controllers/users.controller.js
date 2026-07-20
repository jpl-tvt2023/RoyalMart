const bcrypt = require('bcryptjs');
const db = require('../config/db');
const { logAction, diffFields } = require('../services/auditLog.service');
const { validatePassword } = require('../services/passwordPolicy');
const { ALL_ROLES } = require('../middleware/rbac');

const BCRYPT_COST = 12;
const VALID_ROLES = ALL_ROLES;
const USERNAME_RE = /^[a-z0-9._-]{3,30}$/;

function coerceUser(row) {
  return { ...row, is_first_login: !!row.is_first_login };
}

// Login identifier. Normalised to lowercase; the regex enforces the allowed shape.
function normalizeUsername(input) {
  return String(input || '').trim().toLowerCase();
}

function validateUsername(username) {
  if (!username) return 'User ID is required';
  if (!USERNAME_RE.test(username)) {
    return 'User ID must be 3-30 characters: lowercase letters, numbers, dot, underscore or hyphen';
  }
  return null;
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

// Minimal, low-privilege listing (id + name only) for pickers like "Approved
// By" that any logged-in user needs to populate, unlike the full `list()`
// below which is Admin/Owner-only and exposes roles/login metadata.
async function listLite(req, res, next) {
  try {
    const { role } = req.query;
    const { rows } = role
      ? await db.execute({
          sql: `SELECT u.id, u.name FROM users u
                JOIN user_roles r ON r.user_id = u.id
                WHERE r.role = ? ORDER BY u.name ASC`,
          args: [role],
        })
      : await db.execute('SELECT id, name FROM users ORDER BY name ASC');
    res.json(rows);
  } catch (err) { next(err); }
}

async function list(req, res, next) {
  try {
    const { rows } = await db.execute(
      `SELECT u.id, u.name, u.username, u.is_first_login, u.created_at, u.updated_at,
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
    const { name, password, roles } = req.body;
    const username = normalizeUsername(req.body.username);
    if (!name || !username || !password) {
      return res.status(400).json({ message: 'name, user ID, and password are required' });
    }
    const usernameErr = validateUsername(username);
    if (usernameErr) return res.status(400).json({ message: usernameErr });
    const rolesErr = validateRoles(roles);
    if (rolesErr) return res.status(400).json({ message: rolesErr });

    const policyError = await validatePassword(password);
    if (policyError) return res.status(400).json({ message: policyError });

    const hash = await bcrypt.hash(password, BCRYPT_COST);
    // `email` is a retained NOT NULL UNIQUE column no longer used for login; auto-fill it
    // from the username so the constraint is satisfied.
    const email = `${username}@local`;
    const { rows } = await db.execute({
      sql: `INSERT INTO users (name, username, email, password_hash, is_first_login)
            VALUES (?,?,?,?,1) RETURNING id, name, username, is_first_login, created_at`,
      args: [name, username, email, hash],
    });
    const userId = rows[0].id;
    await replaceRoles(userId, roles);

    await logAction({ userId: req.user.id, actionType: 'USER_CREATE', description: `Created user ${username} (${roles.join(',')})`, entityType: 'user', entityId: userId });
    res.status(201).json({ ...coerceUser(rows[0]), roles: [...new Set(roles)] });
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ message: 'User ID already exists' });
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
      sql: 'SELECT id, name, username, is_first_login FROM users WHERE id = ?',
      args: [id],
    });
    if (!before.length) return res.status(404).json({ message: 'User not found' });
    const prevRoles = (await fetchRolesMap([before[0].id])).get(before[0].id) || [];

    const { rows } = await db.execute({
      sql: `UPDATE users SET name = COALESCE(?, name), updated_by = ?, updated_at = datetime('now')
            WHERE id = ? RETURNING id, name, username, is_first_login`,
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
    await logAction({ userId: req.user.id, actionType: 'USER_UPDATE', description: `Updated user ${userRow.username} (${finalRoles.join(',')})`, entityType: 'user', entityId: userRow.id, changes });
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
    // Authorship links (created/onboarded/updated) can't be auto-resolved — block them.
    const { rows: authRows } = await db.execute({
      sql: 'SELECT COUNT(*) AS c FROM marketplace_pos WHERE created_by = ? OR onboarded_by = ? OR updated_by = ?',
      args: [id, id, id],
    });
    const authCount = authRows[0].c;
    if (authCount > 0) {
      return res.status(409).json({
        message: `Cannot delete: user is linked to ${authCount} purchase order${authCount !== 1 ? 's' : ''} as creator/owner. Reassign those records first.`,
      });
    }

    // POC tag assignments (office_poc / warehouse_poc) are FKs too — deleting while a PO
    // references the user throws a raw FK error. Surface a confirm and, when forced,
    // unassign the user from those POs before deleting.
    const force = req.query.force === 'true';
    const { rows: pocRows } = await db.execute({
      sql: 'SELECT COUNT(*) AS c FROM marketplace_pos WHERE office_poc = ? OR warehouse_poc = ?',
      args: [id, id],
    });
    const pocCount = pocRows[0].c;
    if (pocCount > 0 && !force) {
      return res.status(409).json({
        requiresPocUnassign: true,
        pocCount,
        message: `This user is the POC on ${pocCount} purchase order${pocCount !== 1 ? 's' : ''}. Deleting will unassign them from those orders. Continue?`,
      });
    }
    if (pocCount > 0 && force) {
      await db.execute({ sql: 'UPDATE marketplace_pos SET office_poc = NULL WHERE office_poc = ?', args: [id] });
      await db.execute({ sql: 'UPDATE marketplace_pos SET warehouse_poc = NULL WHERE warehouse_poc = ?', args: [id] });
    }

    const { rows } = await db.execute({ sql: 'DELETE FROM users WHERE id = ? RETURNING username', args: [id] });
    if (!rows.length) return res.status(404).json({ message: 'User not found' });
    await logAction({ userId: req.user.id, actionType: 'USER_DELETE', description: `Deleted user ${rows[0].username}${pocCount > 0 ? ` (unassigned from ${pocCount} PO POC slot${pocCount !== 1 ? 's' : ''})` : ''}`, entityType: 'user', entityId: id });
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
      sql: 'UPDATE users SET password_hash = ?, is_first_login = 1, mfa_enabled = 0, mfa_secret = NULL WHERE id = ? RETURNING username',
      args: [hash, id],
    });
    if (!rows.length) return res.status(404).json({ message: 'User not found' });
    await logAction({ userId: req.user.id, actionType: 'PASSWORD_RESET', description: `Admin reset password for ${rows[0].username}`, entityType: 'user', entityId: id });
    res.json({ message: 'Password reset. User will be prompted to change on next login.' });
  } catch (err) { next(err); }
}

module.exports = {
  listLite, list, create, update, remove, adminResetPassword };
