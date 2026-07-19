const db = require('../config/db');
const { logAction, diffFields } = require('../services/auditLog.service');

function normName(v) {
  return v == null ? '' : String(v).trim();
}

async function list(req, res, next) {
  try {
    const { rows } = await db.execute(
      `SELECT c.id, c.name, c.is_active, c.created_at, c.updated_at,
              u.name AS updated_by_name
       FROM companies c
       LEFT JOIN users u ON u.id = c.updated_by
       ORDER BY c.is_active DESC, c.name ASC`
    );
    res.json(rows);
  } catch (err) { next(err); }
}

async function create(req, res, next) {
  try {
    const name = normName(req.body?.name);
    if (!name) return res.status(400).json({ message: 'name is required' });
    const { rows } = await db.execute({
      sql: 'INSERT INTO companies (name) VALUES (?) RETURNING id, name, is_active, created_at',
      args: [name],
    });
    await logAction({
      userId: req.user.id,
      actionType: 'COMPANY_CREATE',
      description: `Added company "${name}"`,
      entityType: 'company',
      entityId: rows[0].id,
    });
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ message: 'A company with that name already exists' });
    }
    next(err);
  }
}

async function update(req, res, next) {
  try {
    const { id } = req.params;
    const has = (k) => Object.prototype.hasOwnProperty.call(req.body || {}, k);
    const { rows: existing } = await db.execute({
      sql: 'SELECT id, name, is_active FROM companies WHERE id = ?',
      args: [id],
    });
    if (!existing.length) return res.status(404).json({ message: 'Company not found' });
    const current = existing[0];

    let nextName = current.name;
    if (has('name')) {
      const n = normName(req.body.name);
      if (!n) return res.status(400).json({ message: 'name cannot be empty' });
      nextName = n;
    }
    let nextActive = current.is_active;
    if (has('is_active')) nextActive = req.body.is_active ? 1 : 0;

    const changes = diffFields(current, { name: nextName, is_active: nextActive }, ['name', 'is_active']);
    const { rows } = await db.execute({
      sql: `UPDATE companies SET name = ?, is_active = ?, updated_by = ?, updated_at = datetime('now')
            WHERE id = ? RETURNING id, name, is_active, created_at, updated_at`,
      args: [nextName, nextActive, req.user.id, id],
    });
    await logAction({
      userId: req.user.id,
      actionType: 'COMPANY_UPDATE',
      description: `Updated company #${id}: name="${nextName}", active=${nextActive}`,
      entityType: 'company',
      entityId: id,
      changes,
    });
    res.json(rows[0]);
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ message: 'A company with that name already exists' });
    }
    next(err);
  }
}

async function remove(req, res, next) {
  try {
    const { id } = req.params;
    const { rows: existing } = await db.execute({
      sql: 'SELECT id, name FROM companies WHERE id = ?',
      args: [id],
    });
    if (!existing.length) return res.status(404).json({ message: 'Company not found' });
    const { rows } = await db.execute({
      sql: 'UPDATE companies SET is_active = 0 WHERE id = ? RETURNING id, name, is_active, created_at',
      args: [id],
    });
    await logAction({
      userId: req.user.id,
      actionType: 'COMPANY_DEACTIVATE',
      description: `Deactivated company "${existing[0].name}"`,
      entityType: 'company',
      entityId: id,
    });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

module.exports = { list, create, update, remove };
