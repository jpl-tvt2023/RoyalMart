const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { authenticator } = require('otplib');
const db = require('../config/db');
const { logAction } = require('../services/auditLog.service');
const { validatePassword } = require('../services/passwordPolicy');

const MFA_ISSUER = 'Royal Mart ROMS';
const {
  JWT_ACCESS_SECRET, JWT_REFRESH_SECRET,
  JWT_ACCESS_EXPIRY, JWT_REFRESH_EXPIRY,
} = require('../config/env');

const BCRYPT_COST = 12;

function signAccess(user) {
  return jwt.sign(
    { id: user.id, email: user.email, name: user.name, roles: user.roles || [] },
    JWT_ACCESS_SECRET,
    { expiresIn: JWT_ACCESS_EXPIRY }
  );
}

async function loadUserRoles(userId) {
  const { rows } = await db.execute({
    sql: 'SELECT role FROM user_roles WHERE user_id = ? ORDER BY role',
    args: [userId],
  });
  return rows.map(r => r.role);
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
    if (!user) {
      await logAction({ actionType: 'LOGIN_FAILED', description: `Failed login for unknown email ${email}`, entityType: 'user' });
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      await logAction({ userId: user.id, actionType: 'LOGIN_FAILED', description: `Failed login (bad password) for ${user.email}`, entityType: 'user', entityId: user.id });
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    // Second factor (only for users who have enrolled & enabled TOTP).
    if (user.mfa_enabled && user.mfa_secret) {
      const { mfaToken } = req.body;
      if (!mfaToken) {
        return res.json({ mfaRequired: true });
      }
      const mfaValid = authenticator.verify({ token: String(mfaToken), secret: user.mfa_secret });
      if (!mfaValid) {
        await logAction({ userId: user.id, actionType: 'LOGIN_FAILED', description: `Failed login (bad MFA code) for ${user.email}`, entityType: 'user', entityId: user.id });
        return res.status(401).json({ message: 'Invalid credentials' });
      }
    }

    user.roles = await loadUserRoles(user.id);
    const accessToken = signAccess(user);
    const refreshToken = signRefresh(user.id);

    const isProd = process.env.NODE_ENV === 'production';
    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      sameSite: isProd ? 'none' : 'strict',
      secure: isProd,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    await logAction({ userId: user.id, actionType: 'LOGIN', description: `${user.name} logged in`, entityType: 'user', entityId: user.id });

    res.json({
      accessToken,
      user: { id: user.id, name: user.name, email: user.email, roles: user.roles, is_first_login: !!user.is_first_login },
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

    user.roles = await loadUserRoles(user.id);
    res.json({ accessToken: signAccess(user) });
  } catch (err) { next(err); }
}

async function changePassword(req, res, next) {
  try {
    const { oldPassword, newPassword } = req.body;
    const policyError = await validatePassword(newPassword);
    if (policyError) return res.status(400).json({ message: policyError });
    const { rows } = await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [req.user.id] });
    const user = rows[0];

    if (!user.is_first_login) {
      if (!oldPassword) return res.status(400).json({ message: 'Old password required' });
      const valid = await bcrypt.compare(oldPassword, user.password_hash);
      if (!valid) return res.status(401).json({ message: 'Old password incorrect' });
    }

    const hash = await bcrypt.hash(newPassword, BCRYPT_COST);
    await db.execute({
      sql: 'UPDATE users SET password_hash = ?, is_first_login = 0 WHERE id = ?',
      args: [hash, user.id],
    });

    await logAction({ userId: user.id, actionType: 'PASSWORD_CHANGE', description: `${user.name} changed password`, entityType: 'user', entityId: user.id });

    res.json({ message: 'Password updated successfully' });
  } catch (err) { next(err); }
}

async function logout(req, res) {
  const isProd = process.env.NODE_ENV === 'production';
  res.clearCookie('refreshToken', {
    httpOnly: true,
    sameSite: isProd ? 'none' : 'strict',
    secure: isProd,
  });
  res.json({ message: 'Logged out' });
}

// --- MFA (TOTP) — opt-in second factor ---

// Begin enrollment: generate a secret and return the otpauth URL for the
// authenticator app. Not active until the user verifies a code (mfa_enabled
// stays 0). Re-enrolling overwrites any prior unverified secret.
async function mfaEnroll(req, res, next) {
  try {
    const secret = authenticator.generateSecret();
    await db.execute({
      sql: 'UPDATE users SET mfa_secret = ?, mfa_enabled = 0 WHERE id = ?',
      args: [secret, req.user.id],
    });
    const otpauthUrl = authenticator.keyuri(req.user.email, MFA_ISSUER, secret);
    res.json({ secret, otpauthUrl });
  } catch (err) { next(err); }
}

// Verify a code against the enrolled secret and turn MFA on.
async function mfaVerify(req, res, next) {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ message: 'Token is required' });
    const { rows } = await db.execute({ sql: 'SELECT mfa_secret FROM users WHERE id = ?', args: [req.user.id] });
    const secret = rows[0]?.mfa_secret;
    if (!secret) return res.status(400).json({ message: 'Start enrollment first' });
    if (!authenticator.verify({ token: String(token), secret })) {
      return res.status(400).json({ message: 'Invalid code' });
    }
    await db.execute({ sql: 'UPDATE users SET mfa_enabled = 1 WHERE id = ?', args: [req.user.id] });
    await logAction({ userId: req.user.id, actionType: 'MFA_ENABLED', description: `${req.user.name} enabled MFA`, entityType: 'user', entityId: req.user.id });
    res.json({ message: 'MFA enabled' });
  } catch (err) { next(err); }
}

// Disable MFA — requires a valid current code to prove possession.
async function mfaDisable(req, res, next) {
  try {
    const { token } = req.body;
    const { rows } = await db.execute({ sql: 'SELECT mfa_secret, mfa_enabled FROM users WHERE id = ?', args: [req.user.id] });
    const row = rows[0];
    if (!row?.mfa_enabled) return res.status(400).json({ message: 'MFA is not enabled' });
    if (!token || !authenticator.verify({ token: String(token), secret: row.mfa_secret })) {
      return res.status(400).json({ message: 'A valid current code is required to disable MFA' });
    }
    await db.execute({ sql: 'UPDATE users SET mfa_enabled = 0, mfa_secret = NULL WHERE id = ?', args: [req.user.id] });
    await logAction({ userId: req.user.id, actionType: 'MFA_DISABLED', description: `${req.user.name} disabled MFA`, entityType: 'user', entityId: req.user.id });
    res.json({ message: 'MFA disabled' });
  } catch (err) { next(err); }
}

module.exports = { login, refresh, changePassword, logout, mfaEnroll, mfaVerify, mfaDisable };
