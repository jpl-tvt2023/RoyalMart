const db = require('../config/db');
const { logAction, diffFields } = require('../services/auditLog.service');

const PVC_FIELDS = ['product_id', 'vendor', 'vendor_item_code', 'product_description'];

async function list(req, res, next) {
  try {
    const { rows } = await db.execute(`
      SELECT pvc.id, pvc.product_id, pvc.vendor, pvc.vendor_item_code,
             pvc.product_description, pvc.created_at, pvc.updated_at,
             p.sku_code, p.description AS product_name,
             u.name AS updated_by_name
      FROM product_vendor_codes pvc
      JOIN products p ON p.id = pvc.product_id
      LEFT JOIN users u ON u.id = pvc.updated_by
      ORDER BY p.sku_code, pvc.vendor
    `);
    res.json(rows);
  } catch (err) { next(err); }
}

function validate(body) {
  const { product_id, vendor, vendor_item_code } = body;
  if (!Number.isInteger(Number(product_id))) return 'product_id is required';
  if (!vendor || !String(vendor).trim()) return 'vendor is required';
  if (!vendor_item_code || !String(vendor_item_code).trim()) return 'vendor_item_code is required';
  return null;
}

function normDesc(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

async function create(req, res, next) {
  try {
    const err = validate(req.body);
    if (err) return res.status(400).json({ message: err });
    const { product_id, vendor, vendor_item_code, product_description } = req.body;

    const { rows: p } = await db.execute({
      sql: 'SELECT id, sku_code FROM products WHERE id = ?',
      args: [Number(product_id)],
    });
    if (!p.length) return res.status(400).json({ message: 'Product not found' });

    const { rows } = await db.execute({
      sql: `INSERT INTO product_vendor_codes (product_id, vendor, vendor_item_code, product_description)
            VALUES (?, ?, ?, ?) RETURNING *`,
      args: [Number(product_id), String(vendor).trim(), String(vendor_item_code).trim(), normDesc(product_description)],
    });
    await logAction({
      userId: req.user.id,
      actionType: 'PRODUCT_VENDOR_CODE_CREATE',
      description: `Mapped ${p[0].sku_code} → ${vendor}/${vendor_item_code}`,
      entityType: 'product_vendor_code',
      entityId: rows[0].id,
    });
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ message: 'That vendor + vendor item code is already mapped' });
    }
    next(err);
  }
}

async function update(req, res, next) {
  try {
    const { id } = req.params;
    const err = validate(req.body);
    if (err) return res.status(400).json({ message: err });
    const { product_id, vendor, vendor_item_code, product_description } = req.body;

    const { rows: existing } = await db.execute({ sql: 'SELECT * FROM product_vendor_codes WHERE id = ?', args: [id] });
    if (!existing.length) return res.status(404).json({ message: 'Mapping not found' });

    const { rows } = await db.execute({
      sql: `UPDATE product_vendor_codes
            SET product_id = ?, vendor = ?, vendor_item_code = ?, product_description = ?,
                updated_by = ?, updated_at = datetime('now')
            WHERE id = ? RETURNING *`,
      args: [Number(product_id), String(vendor).trim(), String(vendor_item_code).trim(), normDesc(product_description), req.user.id, id],
    });
    const changes = diffFields(existing[0], rows[0], PVC_FIELDS);
    await logAction({
      userId: req.user.id,
      actionType: 'PRODUCT_VENDOR_CODE_UPDATE',
      description: `Updated mapping #${id} → ${vendor}/${vendor_item_code}`,
      entityType: 'product_vendor_code',
      entityId: id,
      changes,
    });
    res.json(rows[0]);
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ message: 'That vendor + vendor item code is already mapped' });
    }
    next(err);
  }
}

async function remove(req, res, next) {
  try {
    const { id } = req.params;
    const { rows } = await db.execute({
      sql: 'DELETE FROM product_vendor_codes WHERE id = ? RETURNING id',
      args: [id],
    });
    if (!rows.length) return res.status(404).json({ message: 'Mapping not found' });
    await logAction({
      userId: req.user.id,
      actionType: 'PRODUCT_VENDOR_CODE_DELETE',
      description: `Deleted mapping #${id}`,
      entityType: 'product_vendor_code',
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
        sql: `DELETE FROM product_vendor_codes WHERE id IN (${placeholders}) RETURNING id`,
        args: cleanIds,
      });
      await logAction({
        client: tx,
        userId: req.user.id,
        actionType: 'PRODUCT_VENDOR_CODE_BULK_DELETE',
        description: `Deleted ${rows.length} mapping${rows.length !== 1 ? 's' : ''}`,
        entityType: 'product_vendor_code',
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

const BULK_LIMIT = 2000;

async function bulkUpsert(req, res, next) {
  try {
    const { rows: input } = req.body || {};
    if (!Array.isArray(input) || input.length === 0) {
      return res.status(400).json({ message: 'rows must be a non-empty array' });
    }
    if (input.length > BULK_LIMIT) {
      return res.status(400).json({ message: `Too many rows; max ${BULK_LIMIT}` });
    }

    const { rows: skus } = await db.execute('SELECT id, sku_code FROM products');
    const skuToId = new Map(skus.map(s => [String(s.sku_code).trim().toLowerCase(), s.id]));

    const { rows: existing } = await db.execute('SELECT vendor, vendor_item_code FROM product_vendor_codes');
    const existingKeys = new Set(existing.map(e => `${e.vendor}\u0001${e.vendor_item_code}`));

    const skipped = [];
    let inserted = 0;
    let updated = 0;

    for (let i = 0; i < input.length; i++) {
      const r = input[i] || {};
      const sku_code = String(r.sku_code || '').trim();
      const vendor = String(r.vendor || '').trim();
      const vendor_item_code = String(r.vendor_item_code || '').trim();
      const product_description = normDesc(r.product_description);

      if (!sku_code || !vendor || !vendor_item_code) {
        skipped.push({ row: i + 2, reason: 'Missing required field(s)' });
        continue;
      }
      const product_id = skuToId.get(sku_code.toLowerCase());
      if (!product_id) {
        skipped.push({ row: i + 2, reason: `Unknown sku_code "${sku_code}"` });
        continue;
      }

      const key = `${vendor}\u0001${vendor_item_code}`;
      const isUpdate = existingKeys.has(key);

      try {
        await db.execute({
          sql: `INSERT INTO product_vendor_codes (product_id, vendor, vendor_item_code, product_description, updated_by, updated_at)
                VALUES (?, ?, ?, ?, ?, datetime('now'))
                ON CONFLICT(vendor, vendor_item_code) DO UPDATE SET
                  product_id = excluded.product_id,
                  product_description = excluded.product_description,
                  updated_by = excluded.updated_by,
                  updated_at = excluded.updated_at`,
          args: [product_id, vendor, vendor_item_code, product_description, req.user.id],
        });
        if (isUpdate) updated++;
        else { inserted++; existingKeys.add(key); }
      } catch (e) {
        skipped.push({ row: i + 2, reason: e.message || 'DB error' });
      }
    }

    await logAction({
      userId: req.user.id,
      actionType: 'PRODUCT_VENDOR_CODE_BULK_UPSERT',
      description: `Bulk: +${inserted} inserted, ~${updated} updated, !${skipped.length} skipped`,
      entityType: 'product_vendor_code',
      entityId: null,
    });

    res.json({ inserted, updated, skipped });
  } catch (err) { next(err); }
}

module.exports = { list, create, update, remove, bulkDelete, bulkUpsert };
