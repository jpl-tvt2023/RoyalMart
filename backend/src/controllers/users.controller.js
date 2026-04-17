const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const { logAction } = require('../services/auditLog.service');

async function list(req, res, next) {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, email, role, is_first_login, created_at FROM users ORDER BY created_at DESC'
    );
    res.json(rows);
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
    const { rows } = await pool.query(
      `INSERT INTO users (name, email, password_hash, role, is_first_login)
       VALUES ($1,$2,$3,$4,true) RETURNING id, name, email, role, is_first_login, created_at`,
      [name, email, hash, role]
    );
    await logAction({ userId: req.user.id, actionType: 'USER_CREATE', description: `Created user ${email} (${role})`, entityType: 'user', entityId: rows[0].id });
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ message: 'Email already exists' });
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
    let i = 1;
    if (name) { updates.push(`name = $${i++}`); values.push(name); }
    if (role) { updates.push(`role = $${i++}`); values.push(role); }
    values.push(id);

    const { rows } = await pool.query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${i} RETURNING id, name, email, role, is_first_login`,
      values
    );
    if (!rows.length) return res.status(404).json({ message: 'User not found' });
    await logAction({ userId: req.user.id, actionType: 'USER_UPDATE', description: `Updated user ${rows[0].email}`, entityType: 'user', entityId: rows[0].id });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

async function remove(req, res, next) {
  try {
    const { id } = req.params;
    if (parseInt(id) === req.user.id) {
      return res.status(400).json({ message: 'Cannot delete your own account' });
    }
    const { rows } = await pool.query('DELETE FROM users WHERE id = $1 RETURNING email', [id]);
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
    const { rows } = await pool.query(
      'UPDATE users SET password_hash = $1, is_first_login = true WHERE id = $2 RETURNING email',
      [hash, id]
    );
    if (!rows.length) return res.status(404).json({ message: 'User not found' });
    await logAction({ userId: req.user.id, actionType: 'PASSWORD_RESET', description: `Admin reset password for ${rows[0].email}`, entityType: 'user', entityId: id });
    res.json({ message: 'Password reset. User will be prompted to change on next login.' });
  } catch (err) { next(err); }
}

module.exports = { list, create, update, remove, adminResetPassword };
