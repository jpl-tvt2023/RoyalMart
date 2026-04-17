const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/db');
const { logAction } = require('../services/auditLog.service');
const {
  JWT_ACCESS_SECRET, JWT_REFRESH_SECRET,
  JWT_ACCESS_EXPIRY, JWT_REFRESH_EXPIRY,
} = require('../config/env');

function signAccess(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, name: user.name },
    JWT_ACCESS_SECRET,
    { expiresIn: JWT_ACCESS_EXPIRY }
  );
}

function signRefresh(userId) {
  return jwt.sign({ id: userId }, JWT_REFRESH_SECRET, { expiresIn: JWT_REFRESH_EXPIRY });
}

async function login(req, res, next) {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required' });
    }
    const { rows } = await db.execute({ sql: 'SELECT * FROM users WHERE email = ?', args: [email] });
    const user = rows[0];
    if (!user) return res.status(401).json({ message: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ message: 'Invalid credentials' });

    const accessToken = signAccess(user);
    const refreshToken = signRefresh(user.id);

    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      secure: process.env.NODE_ENV === 'production',
    });

    await logAction({ userId: user.id, actionType: 'LOGIN', description: `${user.name} logged in`, entityType: 'user', entityId: user.id });

    res.json({
      accessToken,
      user: { id: user.id, name: user.name, email: user.email, role: user.role, is_first_login: !!user.is_first_login },
    });
  } catch (err) { next(err); }
}

async function refresh(req, res, next) {
  try {
    const token = req.cookies.refreshToken;
    if (!token) return res.status(401).json({ message: 'No refresh token' });
    let payload;
    try { payload = jwt.verify(token, JWT_REFRESH_SECRET); }
    catch { return res.status(401).json({ message: 'Invalid refresh token' }); }

    const { rows } = await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [payload.id] });
    const user = rows[0];
    if (!user) return res.status(401).json({ message: 'User not found' });

    res.json({ accessToken: signAccess(user) });
  } catch (err) { next(err); }
}

async function changePassword(req, res, next) {
  try {
    const { oldPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ message: 'New password must be at least 8 characters' });
    }
    const { rows } = await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [req.user.id] });
    const user = rows[0];

    if (!user.is_first_login) {
      if (!oldPassword) return res.status(400).json({ message: 'Old password required' });
      const valid = await bcrypt.compare(oldPassword, user.password_hash);
      if (!valid) return res.status(401).json({ message: 'Old password incorrect' });
    }

    const hash = await bcrypt.hash(newPassword, 10);
    await db.execute({
      sql: 'UPDATE users SET password_hash = ?, is_first_login = 0 WHERE id = ?',
      args: [hash, user.id],
    });

    await logAction({ userId: user.id, actionType: 'PASSWORD_CHANGE', description: `${user.name} changed password`, entityType: 'user', entityId: user.id });

    res.json({ message: 'Password updated successfully' });
  } catch (err) { next(err); }
}

async function logout(req, res) {
  res.clearCookie('refreshToken');
  res.json({ message: 'Logged out' });
}

module.exports = { login, refresh, changePassword, logout };
