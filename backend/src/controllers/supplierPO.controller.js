const db = require('../config/db');
const { logAction } = require('../services/auditLog.service');
const { applyPOStatusChange } = require('../services/inventory.service');

async function list(req, res, next) {
  try {
    const { rows } = await db.execute(`
      SELECT sp.*, p.sku_code, p.name AS sku_name, u.name AS created_by_name
      FROM supplier_pos sp
      JOIN products p ON p.id = sp.sku_id
      JOIN users u ON u.id = sp.created_by
      ORDER BY sp.created_at DESC
    `);
    res.json(rows);
  } catch (err) { next(err); }
}

async function create(req, res, next) {
  try {
    const { supplier_name, sku_id, quantity } = req.body;
    if (!supplier_name || !sku_id || !quantity) {
      return res.status(400).json({ message: 'supplier_name, sku_id, and quantity are required' });
    }
    if (quantity <= 0) return res.status(400).json({ message: 'quantity must be positive' });

    const { rows: skuCheck } = await db.execute({ sql: 'SELECT id FROM products WHERE id = ?', args: [sku_id] });
    if (!skuCheck.length) return res.status(404).json({ message: 'SKU not found' });

    const { rows } = await db.execute({
      sql: `INSERT INTO supplier_pos (supplier_name, sku_id, quantity, created_by, status)
            VALUES (?,?,?,?,'Ordered') RETURNING *`,
      args: [supplier_name, sku_id, quantity, req.user.id],
    });
    await logAction({ userId: req.user.id, actionType: 'PO_CREATE', description: `Created PO #${rows[0].id}: ${supplier_name}, SKU ${sku_id}, Qty ${quantity}`, entityType: 'supplier_po', entityId: rows[0].id });
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

async function updateStatus(req, res, next) {
  try {
    const { id } = req.params;
    const { status } = req.body;
    if (!status) return res.status(400).json({ message: 'status is required' });

    const allowedByRole = {
      'Purchase_Team': ['In-Transit', 'Arrived'],
      'Stocks_Team':   ['Received'],
      'Admin':         ['In-Transit', 'Arrived', 'Received'],
      'Owner':         ['In-Transit', 'Arrived', 'Received'],
    };
    const allowed = new Set((req.user.roles || []).flatMap(r => allowedByRole[r] || []));
    if (!allowed.has(status)) {
      return res.status(403).json({ message: `Your role cannot set status to ${status}` });
    }

    const result = await applyPOStatusChange(db, parseInt(id), status, req.user.id);
    res.json(result);
  } catch (err) { next(err); }
}

module.exports = { list, create, updateStatus };
