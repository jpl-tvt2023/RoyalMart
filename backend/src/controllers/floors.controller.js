const db = require('../config/db');
const { logAction, diffFields } = require('../services/auditLog.service');

// Floors master (migration 098) -- where Barcode Station stock is: the floor a
// scanner picks on the Stock count tab, and so the floor each pack was last
// scanned on. Since 106 an entry has no floor and the sticker prints none -- a
// pack gets its location only from a scan. Name-only, the companies shape, and
// deliberately NOT linked to the warehouses master. Delete means deactivate:
// past scans keep pointing at the floor, so an inactive floor only drops out
// of the station's picker.

function normName(v) {
  return v == null ? '' : String(v).trim();
}

const DUPLICATE = 'A floor with that name already exists';

async function list(req, res, next) {
  try {
    const { rows } = await db.execute(
      `SELECT f.id, f.name, f.is_active, f.created_at, f.updated_at,
              u.name AS updated_by_name
       FROM floors f
       LEFT JOIN users u ON u.id = f.updated_by
       ORDER BY f.is_active DESC, f.name ASC`
    );
    res.json(rows);
  } catch (err) { next(err); }
}

async function create(req, res, next) {
  try {
    const name = normName(req.body?.name);
    if (!name) return res.status(400).json({ message: 'name is required' });
    const { rows } = await db.execute({
      sql: 'INSERT INTO floors (name, updated_by) VALUES (?, ?) RETURNING id, name, is_active, created_at',
      args: [name, req.user.id],
    });
    await logAction({
      userId: req.user.id,
      actionType: 'FLOOR_CREATE',
      description: `Added floor "${name}"`,
      entityType: 'floor',
      entityId: rows[0].id,
    });
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ message: DUPLICATE });
    }
    next(err);
  }
}

async function update(req, res, next) {
  try {
    const { id } = req.params;
    const has = (k) => Object.prototype.hasOwnProperty.call(req.body || {}, k);
    const { rows: existing } = await db.execute({
      sql: 'SELECT id, name, is_active FROM floors WHERE id = ?',
      args: [id],
    });
    if (!existing.length) return res.status(404).json({ message: 'Floor not found' });
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
      sql: `UPDATE floors SET name = ?, is_active = ?, updated_by = ?, updated_at = datetime('now')
            WHERE id = ? RETURNING id, name, is_active, created_at, updated_at`,
      args: [nextName, nextActive, req.user.id, id],
    });
    await logAction({
      userId: req.user.id,
      actionType: 'FLOOR_UPDATE',
      description: `Updated floor #${id}: name="${nextName}", active=${nextActive}`,
      entityType: 'floor',
      entityId: id,
      changes,
    });
    res.json(rows[0]);
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ message: DUPLICATE });
    }
    next(err);
  }
}

async function remove(req, res, next) {
  try {
    const { id } = req.params;
    const { rows: existing } = await db.execute({
      sql: 'SELECT id, name FROM floors WHERE id = ?',
      args: [id],
    });
    if (!existing.length) return res.status(404).json({ message: 'Floor not found' });
    const { rows } = await db.execute({
      sql: `UPDATE floors SET is_active = 0, updated_by = ?, updated_at = datetime('now')
            WHERE id = ? RETURNING id, name, is_active, created_at`,
      args: [req.user.id, id],
    });
    await logAction({
      userId: req.user.id,
      actionType: 'FLOOR_DEACTIVATE',
      description: `Deactivated floor "${existing[0].name}"`,
      entityType: 'floor',
      entityId: id,
    });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

module.exports = { list, create, update, remove };
