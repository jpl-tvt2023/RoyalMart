const db = require('../config/db');
const { logAction } = require('../services/auditLog.service');

async function list(req, res, next) {
  try {
    const { rows } = await db.execute('SELECT * FROM products ORDER BY created_at DESC');
    res.json(rows);
  } catch (err) { next(err); }
}

async function create(req, res, next) {
  const tx = await db.transaction('write');
  try {
    const { sku_code, name, hsn_code, fabric_type, gsm, color, safety_threshold } = req.body;
    if (!sku_code || !name) return res.status(400).json({ message: 'sku_code and name are required' });

    const { rows } = await tx.execute({
      sql: `INSERT INTO products (sku_code, name, hsn_code, fabric_type, gsm, color, safety_threshold)
            VALUES (?,?,?,?,?,?,?) RETURNING *`,
      args: [sku_code, name, hsn_code || null, fabric_type || null, gsm || null, color || null, safety_threshold || 0],
    });
    const product = rows[0];
    await tx.execute({ sql: 'INSERT INTO inventory (sku_id) VALUES (?)', args: [product.id] });
    await logAction({ client: tx, userId: req.user.id, actionType: 'SKU_CREATE', description: `Created SKU ${sku_code}: ${name}`, entityType: 'product', entityId: product.id });
    await tx.commit();
    res.status(201).json(product);
  } catch (err) {
    await tx.rollback();
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
    const { rows } = await db.execute({
      sql: `UPDATE products SET
              sku_code = COALESCE(?, sku_code),
              name = COALESCE(?, name),
              hsn_code = COALESCE(?, hsn_code),
              fabric_type = COALESCE(?, fabric_type),
              gsm = COALESCE(?, gsm),
              color = COALESCE(?, color),
              safety_threshold = COALESCE(?, safety_threshold)
            WHERE id = ? RETURNING *`,
      args: [sku_code||null, name||null, hsn_code||null, fabric_type||null, gsm||null, color||null, safety_threshold??null, id],
    });
    if (!rows.length) return res.status(404).json({ message: 'SKU not found' });
    await logAction({ userId: req.user.id, actionType: 'SKU_UPDATE', description: `Updated SKU ${rows[0].sku_code}`, entityType: 'product', entityId: id });
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
    if (!rows.length) return res.status(404).json({ message: 'SKU not found' });
    await logAction({ userId: req.user.id, actionType: 'SKU_DELETE', description: `Deleted SKU ${rows[0].sku_code}`, entityType: 'product', entityId: id });
    res.json({ message: 'SKU deleted' });
  } catch (err) { next(err); }
}

module.exports = { list, create, update, remove };
