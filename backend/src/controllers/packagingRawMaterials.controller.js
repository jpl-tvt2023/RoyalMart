const db = require('../config/db');
const { logAction, diffFields } = require('../services/auditLog.service');

const PACKAGING_RAW_MATERIAL_FIELDS = ['category', 'item_name', 'unit_metric'];
const BULK_LIMIT = 2000;

function normText(v) {
  return v == null ? '' : String(v).trim();
}

async function list(req, res, next) {
  try {
    const { rows } = await db.execute(`
      SELECT prm.*, u.name AS updated_by_name
      FROM packaging_raw_materials prm
      LEFT JOIN users u ON u.id = prm.updated_by
      ORDER BY prm.category COLLATE NOCASE, prm.item_name COLLATE NOCASE
    `);
    res.json(rows);
  } catch (err) { next(err); }
}

async function create(req, res, next) {
  try {
    const category = normText(req.body.category);
    const itemName = normText(req.body.item_name);
    const unitMetric = normText(req.body.unit_metric);
    if (!category) return res.status(400).json({ message: 'category is required' });
    if (!itemName) return res.status(400).json({ message: 'item_name is required' });
    if (!unitMetric) return res.status(400).json({ message: 'unit_metric is required' });

    const { rows } = await db.execute({
      sql: `INSERT INTO packaging_raw_materials (category, item_name, unit_metric, updated_by, updated_at)
            VALUES (?, ?, ?, ?, datetime('now')) RETURNING *`,
      args: [category, itemName, unitMetric, req.user.id],
    });
    await logAction({
      userId: req.user.id,
      actionType: 'PACKAGING_RAW_MATERIAL_CREATE',
      description: `Created packaging raw material ${category} / ${itemName}`,
      entityType: 'packaging_raw_material',
      entityId: rows[0].id,
    });
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ message: 'This category + item name combination already exists' });
    }
    next(err);
  }
}

async function update(req, res, next) {
  try {
    const { id } = req.params;
    const { rows: existing } = await db.execute({ sql: 'SELECT * FROM packaging_raw_materials WHERE id = ?', args: [id] });
    if (!existing.length) return res.status(404).json({ message: 'Packaging raw material not found' });

    const category = normText(req.body.category ?? existing[0].category);
    const itemName = normText(req.body.item_name ?? existing[0].item_name);
    const unitMetric = normText(req.body.unit_metric ?? existing[0].unit_metric);
    if (!category) return res.status(400).json({ message: 'category is required' });
    if (!itemName) return res.status(400).json({ message: 'item_name is required' });
    if (!unitMetric) return res.status(400).json({ message: 'unit_metric is required' });

    const { rows } = await db.execute({
      sql: `UPDATE packaging_raw_materials
            SET category = ?, item_name = ?, unit_metric = ?, updated_by = ?, updated_at = datetime('now')
            WHERE id = ? RETURNING *`,
      args: [category, itemName, unitMetric, req.user.id, id],
    });
    const changes = diffFields(existing[0], rows[0], PACKAGING_RAW_MATERIAL_FIELDS);
    await logAction({
      userId: req.user.id,
      actionType: 'PACKAGING_RAW_MATERIAL_UPDATE',
      description: `Updated packaging raw material ${category} / ${itemName}`,
      entityType: 'packaging_raw_material',
      entityId: id,
      changes,
    });
    res.json(rows[0]);
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ message: 'This category + item name combination already exists' });
    }
    next(err);
  }
}

async function remove(req, res, next) {
  try {
    const { id } = req.params;
    const { rows } = await db.execute({ sql: 'DELETE FROM packaging_raw_materials WHERE id = ? RETURNING category, item_name', args: [id] });
    if (!rows.length) return res.status(404).json({ message: 'Packaging raw material not found' });
    await logAction({
      userId: req.user.id,
      actionType: 'PACKAGING_RAW_MATERIAL_DELETE',
      description: `Deleted packaging raw material ${rows[0].category} / ${rows[0].item_name}`,
      entityType: 'packaging_raw_material',
      entityId: id,
    });
    res.json({ deleted: true });
  } catch (err) { next(err); }
}

async function bulkDelete(req, res, next) {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: 'ids must be a non-empty array' });
    }
    const cleanIds = ids.map(Number).filter(Number.isInteger);
    if (!cleanIds.length) return res.status(400).json({ message: 'No valid ids provided' });

    const placeholders = cleanIds.map(() => '?').join(',');
    const tx = await db.transaction('write');
    try {
      const { rows } = await tx.execute({
        sql: `DELETE FROM packaging_raw_materials WHERE id IN (${placeholders}) RETURNING id`,
        args: cleanIds,
      });
      await logAction({
        client: tx,
        userId: req.user.id,
        actionType: 'PACKAGING_RAW_MATERIAL_BULK_DELETE',
        description: `Deleted ${rows.length} packaging raw material${rows.length !== 1 ? 's' : ''}`,
        entityType: 'packaging_raw_material',
        entityId: null,
      });
      await tx.commit();
      res.json({ deleted: rows.length });
    } catch (e) {
      await tx.rollback();
      throw e;
    }
  } catch (err) { next(err); }
}

async function bulkUpsert(req, res, next) {
  try {
    const { rows: input } = req.body || {};
    if (!Array.isArray(input) || input.length === 0) {
      return res.status(400).json({ message: 'rows must be a non-empty array' });
    }
    if (input.length > BULK_LIMIT) {
      return res.status(400).json({ message: `Too many rows; max ${BULK_LIMIT}` });
    }

    const { rows: existing } = await db.execute('SELECT category, item_name FROM packaging_raw_materials');
    const existingKeys = new Set(existing.map(e => `${String(e.category).trim().toLowerCase()}|${String(e.item_name).trim().toLowerCase()}`));

    const skipped = [];
    let inserted = 0;
    let updated = 0;

    for (let i = 0; i < input.length; i++) {
      const r = input[i] || {};
      const category = normText(r.category);
      const itemName = normText(r.item_name);
      const unitMetric = normText(r.unit_metric);
      if (!category) { skipped.push({ row: i + 2, reason: 'Missing category' }); continue; }
      if (!itemName) { skipped.push({ row: i + 2, reason: 'Missing item_name' }); continue; }
      if (!unitMetric) { skipped.push({ row: i + 2, reason: 'Missing unit_metric' }); continue; }

      const key = `${category.toLowerCase()}|${itemName.toLowerCase()}`;
      const isUpdate = existingKeys.has(key);
      try {
        await db.execute({
          sql: `INSERT INTO packaging_raw_materials (category, item_name, unit_metric, updated_by, updated_at)
                VALUES (?, ?, ?, ?, datetime('now'))
                ON CONFLICT(category, item_name) DO UPDATE SET
                  unit_metric = excluded.unit_metric,
                  updated_by = excluded.updated_by,
                  updated_at = excluded.updated_at`,
          args: [category, itemName, unitMetric, req.user.id],
        });
        if (isUpdate) updated++;
        else { inserted++; existingKeys.add(key); }
      } catch (e) {
        skipped.push({ row: i + 2, reason: e.message || 'DB error' });
      }
    }

    await logAction({
      userId: req.user.id,
      actionType: 'PACKAGING_RAW_MATERIAL_BULK_UPSERT',
      description: `Bulk: +${inserted} inserted, ~${updated} updated, !${skipped.length} skipped`,
      entityType: 'packaging_raw_material',
      entityId: null,
    });

    res.json({ inserted, updated, skipped });
  } catch (err) { next(err); }
}

module.exports = { list, create, update, remove, bulkDelete, bulkUpsert };
