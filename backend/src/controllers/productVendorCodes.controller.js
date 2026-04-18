const db = require('../config/db');
const { logAction } = require('../services/auditLog.service');

async function list(req, res, next) {
  try {
    const { rows } = await db.execute(`
      SELECT pvc.id, pvc.product_id, pvc.vendor, pvc.vendor_item_code, pvc.created_at,
             p.sku_code, p.name AS product_name
      FROM product_vendor_codes pvc
      JOIN products p ON p.id = pvc.product_id
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

async function create(req, res, next) {
  try {
    const err = validate(req.body);
    if (err) return res.status(400).json({ message: err });
    const { product_id, vendor, vendor_item_code } = req.body;

    const { rows: p } = await db.execute({
      sql: 'SELECT id, sku_code FROM products WHERE id = ?',
      args: [Number(product_id)],
    });
    if (!p.length) return res.status(400).json({ message: 'Product not found' });

    const { rows } = await db.execute({
      sql: `INSERT INTO product_vendor_codes (product_id, vendor, vendor_item_code)
            VALUES (?, ?, ?) RETURNING *`,
      args: [Number(product_id), String(vendor).trim(), String(vendor_item_code).trim()],
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
    const { product_id, vendor, vendor_item_code } = req.body;
    const { rows } = await db.execute({
      sql: `UPDATE product_vendor_codes
            SET product_id = ?, vendor = ?, vendor_item_code = ?
            WHERE id = ? RETURNING *`,
      args: [Number(product_id), String(vendor).trim(), String(vendor_item_code).trim(), id],
    });
    if (!rows.length) return res.status(404).json({ message: 'Mapping not found' });
    await logAction({
      userId: req.user.id,
      actionType: 'PRODUCT_VENDOR_CODE_UPDATE',
      description: `Updated mapping #${id} → ${vendor}/${vendor_item_code}`,
      entityType: 'product_vendor_code',
      entityId: id,
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

module.exports = { list, create, update, remove };
