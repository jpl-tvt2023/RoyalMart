const db = require('../config/db');
const { logAction, diffFields } = require('../services/auditLog.service');

const OUTBOUND_PRODUCT_FIELDS = ['category', 'item_name', 'unit_metric', 'is_active'];

function normName(v) {
  return v == null ? '' : String(v).trim();
}

// The taxonomy is case-insensitive (the table declares COLLATE NOCASE), so
// every in-JS comparison has to lowercase both sides to agree with the DB.
const pairKey = (c, i) => `${normName(c).toLowerCase()}|${normName(i).toLowerCase()}`;

// How many onboarded packaging products sit under each (category, item_name).
// Two queries plus a JS join rather than a correlated subquery, matching the
// vendor_count computation in packagingRawMaterials.controller.js.
async function loadUsageCounts() {
  const { rows } = await db.execute('SELECT category, item_name FROM packaging_raw_materials');
  const counts = new Map();
  for (const r of rows) {
    const k = pairKey(r.category, r.item_name);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return counts;
}

async function list(req, res, next) {
  try {
    const [{ rows }, counts] = await Promise.all([
      db.execute(
        `SELECT p.id, p.category, p.item_name, p.unit_metric, p.is_active,
                p.created_at, p.updated_at, u.name AS updated_by_name
         FROM outbound_products p
         LEFT JOIN users u ON u.id = p.updated_by
         ORDER BY p.is_active DESC, p.category ASC, p.item_name ASC`
      ),
      loadUsageCounts(),
    ]);
    res.json(rows.map(r => ({
      ...r,
      products_using: counts.get(pairKey(r.category, r.item_name)) || 0,
    })));
  } catch (err) { next(err); }
}

async function create(req, res, next) {
  try {
    const category = normName(req.body?.category);
    const itemName = normName(req.body?.item_name);
    const unitMetric = normName(req.body?.unit_metric);
    if (!category) return res.status(400).json({ message: 'category is required' });
    if (!itemName) return res.status(400).json({ message: 'item_name is required' });
    if (!unitMetric) return res.status(400).json({ message: 'unit_metric is required' });

    const { rows } = await db.execute({
      sql: `INSERT INTO outbound_products (category, item_name, unit_metric, updated_by, updated_at)
            VALUES (?, ?, ?, ?, datetime('now'))
            RETURNING id, category, item_name, unit_metric, is_active, created_at, updated_at`,
      args: [category, itemName, unitMetric, req.user.id],
    });
    await logAction({
      userId: req.user.id,
      actionType: 'OUTBOUND_PRODUCT_CREATE',
      description: `Added outbound product ${category} / ${itemName} (${unitMetric})`,
      entityType: 'outbound_product',
      entityId: rows[0].id,
    });
    res.status(201).json({ ...rows[0], products_using: 0 });
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ message: 'This category + item name is already in the Outbound Product List' });
    }
    next(err);
  }
}

async function update(req, res, next) {
  try {
    const { id } = req.params;
    const has = (k) => Object.prototype.hasOwnProperty.call(req.body || {}, k);
    const { rows: existing } = await db.execute({
      sql: 'SELECT id, category, item_name, unit_metric, is_active FROM outbound_products WHERE id = ?',
      args: [id],
    });
    if (!existing.length) return res.status(404).json({ message: 'Outbound product not found' });
    const current = existing[0];

    let nextCategory = current.category;
    if (has('category')) {
      const c = normName(req.body.category);
      if (!c) return res.status(400).json({ message: 'category cannot be empty' });
      nextCategory = c;
    }
    let nextItemName = current.item_name;
    if (has('item_name')) {
      const n = normName(req.body.item_name);
      if (!n) return res.status(400).json({ message: 'item_name cannot be empty' });
      nextItemName = n;
    }
    let nextUnitMetric = current.unit_metric;
    if (has('unit_metric')) {
      const m = normName(req.body.unit_metric);
      if (!m) return res.status(400).json({ message: 'unit_metric cannot be empty' });
      nextUnitMetric = m;
    }
    let nextActive = current.is_active;
    if (has('is_active')) nextActive = req.body.is_active ? 1 : 0;

    // Renaming the identity pair would orphan every packaging product onboarded
    // under it, so it is blocked while any exist. Casing-only corrections are
    // still allowed -- those keep matching, since the comparison is NOCASE.
    const counts = await loadUsageCounts();
    const usage = counts.get(pairKey(current.category, current.item_name)) || 0;
    const renamed = pairKey(nextCategory, nextItemName) !== pairKey(current.category, current.item_name);
    if (renamed && usage > 0) {
      return res.status(409).json({
        message: `${usage} packaging product${usage !== 1 ? 's' : ''} already use "${current.category} / ${current.item_name}" — deactivate this entry instead, or rename those products first`,
      });
    }

    const changes = diffFields(
      current,
      { category: nextCategory, item_name: nextItemName, unit_metric: nextUnitMetric, is_active: nextActive },
      OUTBOUND_PRODUCT_FIELDS,
    );

    // The unit metric lives here now, so a change to it has to reach the
    // packaging products that inherited it -- otherwise the master and the
    // catalog silently disagree. outbound_po_lines.unit_metric is deliberately
    // left alone: migration 057 made it a historical snapshot.
    const metricChanged = nextUnitMetric !== current.unit_metric;
    const tx = await db.transaction('write');
    let updated;
    try {
      const { rows } = await tx.execute({
        sql: `UPDATE outbound_products
              SET category = ?, item_name = ?, unit_metric = ?, is_active = ?,
                  updated_by = ?, updated_at = datetime('now')
              WHERE id = ?
              RETURNING id, category, item_name, unit_metric, is_active, created_at, updated_at`,
        args: [nextCategory, nextItemName, nextUnitMetric, nextActive, req.user.id, id],
      });
      updated = rows[0];

      if (metricChanged) {
        await tx.execute({
          sql: `UPDATE packaging_raw_materials
                SET unit_metric = ?, updated_by = ?, updated_at = datetime('now')
                WHERE LOWER(category) = LOWER(?) AND LOWER(item_name) = LOWER(?)`,
          args: [nextUnitMetric, req.user.id, nextCategory, nextItemName],
        });
      }

      await logAction({
        client: tx,
        userId: req.user.id,
        actionType: 'OUTBOUND_PRODUCT_UPDATE',
        description: `Updated outbound product ${nextCategory} / ${nextItemName}`
          + (metricChanged ? ` — unit metric ${current.unit_metric} → ${nextUnitMetric}, applied to ${usage} packaging product${usage !== 1 ? 's' : ''}` : ''),
        entityType: 'outbound_product',
        entityId: id,
        changes,
      });
      await tx.commit();
    } catch (e) {
      await tx.rollback();
      throw e;
    }

    res.json({ ...updated, products_using: usage });
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ message: 'This category + item name is already in the Outbound Product List' });
    }
    next(err);
  }
}

// Soft delete only. A deactivated entry disappears from the onboarding
// dropdowns but the packaging products already created under it keep working,
// and reactivating restores the entry unchanged.
async function remove(req, res, next) {
  try {
    const { id } = req.params;
    const { rows: existing } = await db.execute({
      sql: 'SELECT id, category, item_name FROM outbound_products WHERE id = ?',
      args: [id],
    });
    if (!existing.length) return res.status(404).json({ message: 'Outbound product not found' });

    const { rows } = await db.execute({
      sql: `UPDATE outbound_products SET is_active = 0, updated_by = ?, updated_at = datetime('now')
            WHERE id = ? RETURNING id, category, item_name, unit_metric, is_active, created_at, updated_at`,
      args: [req.user.id, id],
    });
    await logAction({
      userId: req.user.id,
      actionType: 'OUTBOUND_PRODUCT_DEACTIVATE',
      description: `Deactivated outbound product ${existing[0].category} / ${existing[0].item_name}`,
      entityType: 'outbound_product',
      entityId: id,
    });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

module.exports = { list, create, update, remove };
