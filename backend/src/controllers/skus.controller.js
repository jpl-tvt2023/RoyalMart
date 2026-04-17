const pool = require('../config/db');
const { logAction } = require('../services/auditLog.service');

async function list(req, res, next) {
  try {
    const { rows } = await pool.query('SELECT * FROM products ORDER BY created_at DESC');
    res.json(rows);
  } catch (err) { next(err); }
}

async function create(req, res, next) {
  const client = await pool.connect();
  try {
    const { sku_code, name, hsn_code, fabric_type, gsm, color, safety_threshold } = req.body;
    if (!sku_code || !name) return res.status(400).json({ message: 'sku_code and name are required' });

    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO products (sku_code, name, hsn_code, fabric_type, gsm, color, safety_threshold)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [sku_code, name, hsn_code || null, fabric_type || null, gsm || null, color || null, safety_threshold || 0]
    );
    const product = rows[0];
    await client.query('INSERT INTO inventory (sku_id) VALUES ($1)', [product.id]);
    await logAction({ client, userId: req.user.id, actionType: 'SKU_CREATE', description: `Created SKU ${sku_code}: ${name}`, entityType: 'product', entityId: product.id });
    await client.query('COMMIT');
    res.status(201).json(product);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ message: 'SKU code already exists' });
    next(err);
  } finally { client.release(); }
}

async function update(req, res, next) {
  try {
    const { id } = req.params;
    const { sku_code, name, hsn_code, fabric_type, gsm, color, safety_threshold } = req.body;
    const { rows } = await pool.query(
      `UPDATE products SET
        sku_code = COALESCE($1, sku_code),
        name = COALESCE($2, name),
        hsn_code = COALESCE($3, hsn_code),
        fabric_type = COALESCE($4, fabric_type),
        gsm = COALESCE($5, gsm),
        color = COALESCE($6, color),
        safety_threshold = COALESCE($7, safety_threshold)
       WHERE id = $8 RETURNING *`,
      [sku_code||null, name||null, hsn_code||null, fabric_type||null, gsm||null, color||null, safety_threshold??null, id]
    );
    if (!rows.length) return res.status(404).json({ message: 'SKU not found' });
    await logAction({ userId: req.user.id, actionType: 'SKU_UPDATE', description: `Updated SKU ${rows[0].sku_code}`, entityType: 'product', entityId: id });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ message: 'SKU code already exists' });
    next(err);
  }
}

async function remove(req, res, next) {
  try {
    const { id } = req.params;
    const { rows } = await pool.query('DELETE FROM products WHERE id = $1 RETURNING sku_code', [id]);
    if (!rows.length) return res.status(404).json({ message: 'SKU not found' });
    await logAction({ userId: req.user.id, actionType: 'SKU_DELETE', description: `Deleted SKU ${rows[0].sku_code}`, entityType: 'product', entityId: id });
    res.json({ message: 'SKU deleted' });
  } catch (err) { next(err); }
}

module.exports = { list, create, update, remove };
