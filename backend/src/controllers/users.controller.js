const bcrypt = require('bcryptjs');
const db = require('../config/db');
const { logAction } = require('../services/auditLog.service');

function coerceUser(row) {
  return { ...row, is_first_login: !!row.is_first_login };
}

async function list(req, res, next) {
  try {
    const { rows } = await db.execute(
      'SELECT id, name, email, role, is_first_login, created_at FROM users ORDER BY created_at DESC'
    );
    res.json(rows.map(coerceUser));
  } catch (err) { next(err); }
}

async function create(req, res, next) {
  try {
    const { name, email, role, password } = req.body;
    if (!name || !email || !role || !password) {
      return res.status(400).json({ message: 'name, email, role, and password are required' });
    }
    const validRoles = ['Admin','Owner','Office_POC','Purchase_Team','Stocks_Team'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ message: 'Invalid role' });
    }
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await db.execute({
      sql: `INSERT INTO users (name, email, password_hash, role, is_first_login)
            VALUES (?,?,?,?,1) RETURNING id, name, email, role, is_first_login, created_at`,
      args: [name, email, hash, role],
    });
    await logAction({ userId: req.user.id, actionType: 'USER_CREATE', description: `Created user ${email} (${role})`, entityType: 'user', entityId: rows[0].id });
    res.status(201).json(coerceUser(rows[0]));
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
    const { name, role } = req.body;
    if (!name && !role) return res.status(400).json({ message: 'Nothing to update' });

    const updates = [];
    const values = [];
    if (name) { updates.push('name = ?'); values.push(name); }
    if (role) { updates.push('role = ?'); values.push(role); }
    values.push(id);

    const { rows } = await db.execute({
      sql: `UPDATE users SET ${updates.join(', ')} WHERE id = ? RETURNING id, name, email, role, is_first_login`,
      args: values,
    });
    if (!rows.length) return res.status(404).json({ message: 'User not found' });
    await logAction({ userId: req.user.id, actionType: 'USER_UPDATE', description: `Updated user ${rows[0].email}`, entityType: 'user', entityId: rows[0].id });
    res.json(coerceUser(rows[0]));
  } catch (err) { next(err); }
}

async function remove(req, res, next) {
  try {
    const { id } = req.params;
    if (parseInt(id) === req.user.id) {
      return res.status(400).json({ message: 'Cannot delete your own account' });
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
    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ message: 'Password must be at least 8 characters' });
    }
    const hash = await bcrypt.hash(newPassword, 10);
    const { rows } = await db.execute({
      sql: 'UPDATE users SET password_hash = ?, is_first_login = 1 WHERE id = ? RETURNING email',
      args: [hash, id],
    });
    if (!rows.length) return res.status(404).json({ message: 'User not found' });
    await logAction({ userId: req.user.id, actionType: 'PASSWORD_RESET', description: `Admin reset password for ${rows[0].email}`, entityType: 'user', entityId: id });
    res.json({ message: 'Password reset. User will be prompted to change on next login.' });
  } catch (err) { next(err); }
}

module.exports = { list, create, update, remove, adminResetPassword };
