const db = require('../config/db');
const { logAction, diffFields } = require('../services/auditLog.service');

const PRODUCT_FIELDS = ['sku_code', 'name', 'hsn_code', 'fabric_type', 'gsm', 'color', 'safety_threshold'];

async function list(req, res, next) {
  try {
    const { rows } = await db.execute(
      `SELECT p.*, u.name AS updated_by_name
       FROM products p
       LEFT JOIN users u ON u.id = p.updated_by
       ORDER BY p.created_at DESC`
    );
    res.json(rows);
  } catch (err) { next(err); }
}

async function create(req, res, next) {
  try {
    const { sku_code, name, hsn_code, fabric_type, gsm, color, safety_threshold } = req.body;
    if (!sku_code || !name) return res.status(400).json({ message: 'sku_code and name are required' });

    const { rows } = await db.execute({
      sql: `INSERT INTO products (sku_code, name, hsn_code, fabric_type, gsm, color, safety_threshold)
            VALUES (?,?,?,?,?,?,?) RETURNING *`,
      args: [sku_code, name, hsn_code || null, fabric_type || null, gsm || null, color || null, safety_threshold || 0],
    });
    const product = rows[0];
    await logAction({ userId: req.user.id, actionType: 'PRODUCT_CREATE', description: `Created product ${sku_code}: ${name}`, entityType: 'product', entityId: product.id });
    res.status(201).json(product);
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ message: 'SKU code already exists' });
    }
    next(err);
  }
}

async function update(req, res, next) {
  try {
    const { id } = req.params;
    const { sku_code, name, hsn_code, fabric_type, gsm, color, safety_threshold } = req.body;

    const { rows: existing } = await db.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [id] });
    if (!existing.length) return res.status(404).json({ message: 'Product not found' });
    const current = existing[0];

    const { rows } = await db.execute({
      sql: `UPDATE products SET
              sku_code = COALESCE(?, sku_code),
              name = COALESCE(?, name),
              hsn_code = COALESCE(?, hsn_code),
              fabric_type = COALESCE(?, fabric_type),
              gsm = COALESCE(?, gsm),
              color = COALESCE(?, color),
              safety_threshold = COALESCE(?, safety_threshold),
              updated_by = ?, updated_at = datetime('now')
            WHERE id = ? RETURNING *`,
      args: [sku_code||null, name||null, hsn_code||null, fabric_type||null, gsm||null, color||null, safety_threshold??null, req.user.id, id],
    });
    const changes = diffFields(current, rows[0], PRODUCT_FIELDS);
    await logAction({ userId: req.user.id, actionType: 'PRODUCT_UPDATE', description: `Updated product ${rows[0].sku_code}`, entityType: 'product', entityId: id, changes });
    res.json(rows[0]);
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ message: 'SKU code already exists' });
    }
    next(err);
  }
}

async function remove(req, res, next) {
  try {
    const { id } = req.params;
    const { rows } = await db.execute({ sql: 'DELETE FROM products WHERE id = ? RETURNING sku_code', args: [id] });
    if (!rows.length) return res.status(404).json({ message: 'Product not found' });
    await logAction({ userId: req.user.id, actionType: 'PRODUCT_DELETE', description: `Deleted product ${rows[0].sku_code}`, entityType: 'product', entityId: id });
    res.json({ message: 'Product deleted' });
  } catch (err) { next(err); }
}

module.exports = { list, create, update, remove };
