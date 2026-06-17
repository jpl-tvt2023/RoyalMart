const db = require('../config/db');
const { logAction, diffFields } = require('../services/auditLog.service');
const { hasParser } = require('../parsers/marketplacePO');

function normName(v) {
  return v == null ? '' : String(v).trim();
}

async function list(req, res, next) {
  try {
    const { rows } = await db.execute(
      `SELECT v.id, v.name, v.is_active, v.has_parser, v.created_at, v.updated_at,
              u.name AS updated_by_name
       FROM vendors v
       LEFT JOIN users u ON u.id = v.updated_by
       ORDER BY v.is_active DESC, v.name ASC`
    );
    res.json(rows);
  } catch (err) { next(err); }
}

async function create(req, res, next) {
  try {
    const name = normName(req.body?.name);
    if (!name) return res.status(400).json({ message: 'name is required' });
    const parserAvailable = hasParser(name) ? 1 : 0;
    const { rows } = await db.execute({
      sql: 'INSERT INTO vendors (name, has_parser) VALUES (?, ?) RETURNING id, name, is_active, has_parser, created_at',
      args: [name, parserAvailable],
    });
    await logAction({
      userId: req.user.id,
      actionType: 'VENDOR_CREATE',
      description: `Added vendor "${name}" (parser=${parserAvailable ? 'yes' : 'no'})`,
      entityType: 'vendor',
      entityId: rows[0].id,
    });
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ message: 'A vendor with that name already exists' });
    }
    next(err);
  }
}

async function update(req, res, next) {
  try {
    const { id } = req.params;
    const has = (k) => Object.prototype.hasOwnProperty.call(req.body || {}, k);
    const { rows: existing } = await db.execute({
      sql: 'SELECT id, name, is_active, has_parser FROM vendors WHERE id = ?',
      args: [id],
    });
    if (!existing.length) return res.status(404).json({ message: 'Vendor not found' });
    const current = existing[0];

    let nextName = current.name;
    if (has('name')) {
      const n = normName(req.body.name);
      if (!n) return res.status(400).json({ message: 'name cannot be empty' });
      nextName = n;
    }
    let nextActive = current.is_active;
    if (has('is_active')) nextActive = req.body.is_active ? 1 : 0;
    // `has_parser` is derived from the codebase (the parser registry) and
    // therefore re-evaluated on every update — admins cannot toggle it manually.
    const nextHasParser = hasParser(nextName) ? 1 : 0;

    const changes = diffFields(
      current,
      { name: nextName, is_active: nextActive, has_parser: nextHasParser },
      ['name', 'is_active', 'has_parser'],
    );
    const { rows } = await db.execute({
      sql: `UPDATE vendors SET name = ?, is_active = ?, has_parser = ?,
              updated_by = ?, updated_at = datetime('now')
            WHERE id = ?
            RETURNING id, name, is_active, has_parser, created_at, updated_at`,
      args: [nextName, nextActive, nextHasParser, req.user.id, id],
    });
    await logAction({
      userId: req.user.id,
      actionType: 'VENDOR_UPDATE',
      description: `Updated vendor #${id}: name="${nextName}", active=${nextActive}, parser=${nextHasParser}`,
      entityType: 'vendor',
      entityId: id,
      changes,
    });
    res.json(rows[0]);
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ message: 'A vendor with that name already exists' });
    }
    next(err);
  }
}

async function remove(req, res, next) {
  try {
    const { id } = req.params;
    const { rows: existing } = await db.execute({
      sql: 'SELECT id, name FROM vendors WHERE id = ?',
      args: [id],
    });
    if (!existing.length) return res.status(404).json({ message: 'Vendor not found' });

    const { rows: refs } = await db.execute({
      sql: 'SELECT COUNT(*) AS n FROM marketplace_pos WHERE vendor = ?',
      args: [existing[0].name],
    });
    if (Number(refs[0]?.n) > 0) {
      return res.status(409).json({
        message: `Vendor "${existing[0].name}" has ${refs[0].n} PO(s) and cannot be deactivated. Reassign or delete those POs first.`,
      });
    }

    const { rows } = await db.execute({
      sql: 'UPDATE vendors SET is_active = 0 WHERE id = ? RETURNING id, name, is_active, has_parser, created_at',
      args: [id],
    });
    await logAction({
      userId: req.user.id,
      actionType: 'VENDOR_DEACTIVATE',
      description: `Deactivated vendor "${existing[0].name}"`,
      entityType: 'vendor',
      entityId: id,
    });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

module.exports = { list, create, update, remove };
