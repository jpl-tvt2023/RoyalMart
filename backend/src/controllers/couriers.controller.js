const db = require('../config/db');
const { logAction } = require('../services/auditLog.service');

async function list(req, res, next) {
  try {
    const { rows } = await db.execute(
      'SELECT id, name, is_active, created_at FROM couriers ORDER BY is_active DESC, name ASC'
    );
    res.json(rows);
  } catch (err) { next(err); }
}

function normName(v) {
  if (v == null) return '';
  return String(v).trim();
}

async function create(req, res, next) {
  try {
    const name = normName(req.body?.name);
    if (!name) return res.status(400).json({ message: 'name is required' });

    const { rows } = await db.execute({
      sql: 'INSERT INTO couriers (name) VALUES (?) RETURNING id, name, is_active, created_at',
      args: [name],
    });
    await logAction({
      userId: req.user.id,
      actionType: 'COURIER_CREATE',
      description: `Added courier "${name}"`,
      entityType: 'courier',
      entityId: rows[0].id,
    });
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ message: 'A courier with that name already exists' });
    }
    next(err);
  }
}

async function update(req, res, next) {
  try {
    const { id } = req.params;
    const has = (k) => Object.prototype.hasOwnProperty.call(req.body || {}, k);

    const { rows: existing } = await db.execute({
      sql: 'SELECT id, name, is_active FROM couriers WHERE id = ?',
      args: [id],
    });
    if (!existing.length) return res.status(404).json({ message: 'Courier not found' });
    const current = existing[0];

    let nextName = current.name;
    if (has('name')) {
      const n = normName(req.body.name);
      if (!n) return res.status(400).json({ message: 'name cannot be empty' });
      nextName = n;
    }
    let nextActive = current.is_active;
    if (has('is_active')) {
      nextActive = req.body.is_active ? 1 : 0;
    }

    const { rows } = await db.execute({
      sql: 'UPDATE couriers SET name = ?, is_active = ? WHERE id = ? RETURNING id, name, is_active, created_at',
      args: [nextName, nextActive, id],
    });
    await logAction({
      userId: req.user.id,
      actionType: 'COURIER_UPDATE',
      description: `Updated courier #${id}: name="${nextName}", active=${nextActive}`,
      entityType: 'courier',
      entityId: id,
    });
    res.json(rows[0]);
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ message: 'A courier with that name already exists' });
    }
    next(err);
  }
}

async function remove(req, res, next) {
  try {
    const { id } = req.params;
    const { rows: existing } = await db.execute({
      sql: 'SELECT id, name FROM couriers WHERE id = ?',
      args: [id],
    });
    if (!existing.length) return res.status(404).json({ message: 'Courier not found' });

    const { rows } = await db.execute({
      sql: 'UPDATE couriers SET is_active = 0 WHERE id = ? RETURNING id, name, is_active, created_at',
      args: [id],
    });
    await logAction({
      userId: req.user.id,
      actionType: 'COURIER_DEACTIVATE',
      description: `Deactivated courier "${existing[0].name}"`,
      entityType: 'courier',
      entityId: id,
    });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

module.exports = { list, create, update, remove };
