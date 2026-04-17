const db = require('../config/db');
const { logAction } = require('../services/auditLog.service');

async function list(req, res, next) {
  try {
    const { rows } = await db.execute(
      `SELECT *, CASE WHEN on_hand_qty < safety_threshold THEN 1 ELSE 0 END AS is_critical
       FROM packaging_materials ORDER BY name`
    );
    res.json(rows.map(r => ({ ...r, is_critical: !!r.is_critical })));
  } catch (err) { next(err); }
}

async function create(req, res, next) {
  try {
    const { name, unit, on_hand_qty, safety_threshold } = req.body;
    if (!name) return res.status(400).json({ message: 'name is required' });
    const { rows } = await db.execute({
      sql: `INSERT INTO packaging_materials (name, unit, on_hand_qty, safety_threshold)
            VALUES (?,?,?,?) RETURNING *`,
      args: [name, unit || 'pcs', on_hand_qty || 0, safety_threshold || 0],
    });
    await logAction({ userId: req.user.id, actionType: 'PACKAGING_CREATE', description: `Added packaging material: ${name}`, entityType: 'packaging', entityId: rows[0].id });
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ message: 'A material with this name already exists' });
    }
    next(err);
  }
}

async function update(req, res, next) {
  try {
    const { id } = req.params;
    const { name, unit, safety_threshold } = req.body;
    const { rows } = await db.execute({
      sql: `UPDATE packaging_materials SET
              name = COALESCE(?, name),
              unit = COALESCE(?, unit),
              safety_threshold = COALESCE(?, safety_threshold),
              updated_at = datetime('now')
            WHERE id = ? RETURNING *`,
      args: [name||null, unit||null, safety_threshold??null, id],
    });
    if (!rows.length) return res.status(404).json({ message: 'Packaging material not found' });
    await logAction({ userId: req.user.id, actionType: 'PACKAGING_UPDATE', description: `Updated packaging material: ${rows[0].name}`, entityType: 'packaging', entityId: id });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

async function updateQty(req, res, next) {
  try {
    const { id } = req.params;
    const { on_hand_qty, note } = req.body;
    if (on_hand_qty === undefined || on_hand_qty === null) {
      return res.status(400).json({ message: 'on_hand_qty is required' });
    }
    if (on_hand_qty < 0) return res.status(400).json({ message: 'on_hand_qty cannot be negative' });
    const { rows } = await db.execute({
      sql: `UPDATE packaging_materials SET on_hand_qty = ?, updated_at = datetime('now') WHERE id = ? RETURNING *`,
      args: [on_hand_qty, id],
    });
    if (!rows.length) return res.status(404).json({ message: 'Packaging material not found' });
    await logAction({ userId: req.user.id, actionType: 'PACKAGING_QTY_UPDATE', description: `Updated qty for ${rows[0].name}: ${on_hand_qty}${note ? ` (${note})` : ''}`, entityType: 'packaging', entityId: id });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

async function remove(req, res, next) {
  try {
    const { id } = req.params;
    const { rows } = await db.execute({ sql: 'DELETE FROM packaging_materials WHERE id = ? RETURNING name', args: [id] });
    if (!rows.length) return res.status(404).json({ message: 'Packaging material not found' });
    await logAction({ userId: req.user.id, actionType: 'PACKAGING_DELETE', description: `Deleted packaging material: ${rows[0].name}`, entityType: 'packaging', entityId: id });
    res.json({ message: 'Packaging material deleted' });
  } catch (err) { next(err); }
}

async function auditHistory(req, res, next) {
  try {
    const { id } = req.params;
    const { rows } = await db.execute({
      sql: `SELECT al.id, al.action_type, al.description, al.timestamp, u.name AS user_name
            FROM audit_logs al
            LEFT JOIN users u ON u.id = al.user_id
            WHERE al.entity_type = 'packaging' AND al.entity_id = ?
            ORDER BY al.timestamp DESC LIMIT 50`,
      args: [id],
    });
    res.json(rows);
  } catch (err) { next(err); }
}

module.exports = { list, create, update, updateQty, remove, auditHistory };
