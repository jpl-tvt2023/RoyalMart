const db = require('../config/db');
const { logAction, diffFields } = require('../services/auditLog.service');

const RAW_PRODUCT_FIELDS = ['name', 'qty'];
const BULK_LIMIT = 2000;

function parseQty(val) {
  if (val === null || val === undefined || val === '') return 0;
  const n = Number(val);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

async function list(req, res, next) {
  try {
    const { rows } = await db.execute(`
      SELECT rp.*, u.name AS updated_by_name
      FROM raw_products rp
      LEFT JOIN users u ON u.id = rp.updated_by
      ORDER BY rp.name COLLATE NOCASE
    `);
    res.json(rows);
  } catch (err) { next(err); }
}

async function create(req, res, next) {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ message: 'name is required' });
    const qty = parseQty(req.body.qty);
    if (qty === null) return res.status(400).json({ message: 'qty must be a non-negative integer' });

    const { rows } = await db.execute({
      sql: `INSERT INTO raw_products (name, qty, updated_by, updated_at)
            VALUES (?, ?, ?, datetime('now')) RETURNING *`,
      args: [name, qty, req.user.id],
    });
    await logAction({
      userId: req.user.id,
      actionType: 'RAW_PRODUCT_CREATE',
      description: `Created raw product ${name} (qty ${qty})`,
      entityType: 'raw_product',
      entityId: rows[0].id,
    });
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ message: 'Name already exists' });
    }
    next(err);
  }
}

async function update(req, res, next) {
  try {
    const { id } = req.params;
    const { rows: existing } = await db.execute({ sql: 'SELECT * FROM raw_products WHERE id = ?', args: [id] });
    if (!existing.length) return res.status(404).json({ message: 'Raw product not found' });

    const name = String(req.body.name ?? existing[0].name).trim();
    if (!name) return res.status(400).json({ message: 'name is required' });
    const qty = parseQty(req.body.qty ?? existing[0].qty);
    if (qty === null) return res.status(400).json({ message: 'qty must be a non-negative integer' });

    const { rows } = await db.execute({
      sql: `UPDATE raw_products
            SET name = ?, qty = ?, updated_by = ?, updated_at = datetime('now')
            WHERE id = ? RETURNING *`,
      args: [name, qty, req.user.id, id],
    });
    const changes = diffFields(existing[0], rows[0], RAW_PRODUCT_FIELDS);
    await logAction({
      userId: req.user.id,
      actionType: 'RAW_PRODUCT_UPDATE',
      description: `Updated raw product ${name}`,
      entityType: 'raw_product',
      entityId: id,
      changes,
    });
    res.json(rows[0]);
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ message: 'Name already exists' });
    }
    next(err);
  }
}

async function remove(req, res, next) {
  try {
    const { id } = req.params;
    const { rows } = await db.execute({ sql: 'DELETE FROM raw_products WHERE id = ? RETURNING name', args: [id] });
    if (!rows.length) return res.status(404).json({ message: 'Raw product not found' });
    await logAction({
      userId: req.user.id,
      actionType: 'RAW_PRODUCT_DELETE',
      description: `Deleted raw product ${rows[0].name}`,
      entityType: 'raw_product',
      entityId: id,
    });
    res.json({ deleted: true });
  } catch (err) {
    if (err.message && err.message.includes('FOREIGN KEY constraint failed')) {
      return res.status(409).json({ message: "This raw product is used by one or more SKUs and can't be deleted." });
    }
    next(err);
  }
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
        sql: `DELETE FROM raw_products WHERE id IN (${placeholders}) RETURNING id`,
        args: cleanIds,
      });
      await logAction({
        client: tx,
        userId: req.user.id,
        actionType: 'RAW_PRODUCT_BULK_DELETE',
        description: `Deleted ${rows.length} raw product${rows.length !== 1 ? 's' : ''}`,
        entityType: 'raw_product',
        entityId: null,
      });
      await tx.commit();
      res.json({ deleted: rows.length });
    } catch (e) {
      await tx.rollback();
      throw e;
    }
  } catch (err) {
    if (err.message && err.message.includes('FOREIGN KEY constraint failed')) {
      return res.status(409).json({ message: "One or more selected raw products are used by SKUs and can't be deleted." });
    }
    next(err);
  }
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

    const { rows: existing } = await db.execute('SELECT name FROM raw_products');
    const existingNames = new Set(existing.map(e => String(e.name).trim().toLowerCase()));

    const skipped = [];
    let inserted = 0;
    let updated = 0;

    for (let i = 0; i < input.length; i++) {
      const r = input[i] || {};
      const name = String(r.name || '').trim();
      const qty = parseQty(r.qty);
      if (!name) { skipped.push({ row: i + 2, reason: 'Missing name' }); continue; }
      if (qty === null) { skipped.push({ row: i + 2, reason: 'qty must be a non-negative integer' }); continue; }

      const isUpdate = existingNames.has(name.toLowerCase());
      try {
        await db.execute({
          sql: `INSERT INTO raw_products (name, qty, updated_by, updated_at)
                VALUES (?, ?, ?, datetime('now'))
                ON CONFLICT(name) DO UPDATE SET
                  qty = excluded.qty,
                  updated_by = excluded.updated_by,
                  updated_at = excluded.updated_at`,
          args: [name, qty, req.user.id],
        });
        if (isUpdate) updated++;
        else { inserted++; existingNames.add(name.toLowerCase()); }
      } catch (e) {
        skipped.push({ row: i + 2, reason: e.message || 'DB error' });
      }
    }

    await logAction({
      userId: req.user.id,
      actionType: 'RAW_PRODUCT_BULK_UPSERT',
      description: `Bulk: +${inserted} inserted, ~${updated} updated, !${skipped.length} skipped`,
      entityType: 'raw_product',
      entityId: null,
    });

    res.json({ inserted, updated, skipped });
  } catch (err) { next(err); }
}

module.exports = { list, create, update, remove, bulkDelete, bulkUpsert };
