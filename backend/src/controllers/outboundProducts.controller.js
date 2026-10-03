const db = require('../config/db');
const { logAction, diffFields } = require('../services/auditLog.service');
const { STITCHING_TYPES, FABRIC, isValidStitchingType } = require('../services/stitching.service');

const OUTBOUND_PRODUCT_FIELDS = ['category', 'item_name', 'unit_metric', 'is_active', 'stitching_type', 'goes_to_stitching'];

// Which section of the Stitching page this article's lots show in (migration
// 091): null for anything that never travels it -- packaging, barcodes --
// 'Fabric' or 'Readymade' otherwise. Returns [type, error].
//
// goes_to_stitching is still accepted from a caller that has not moved on: a
// tick means Fabric (or keeps the type already set), an untick means none.
// stitching_type wins when both are sent.
function resolveStitchingType(body, current = null) {
  const has = (k) => Object.prototype.hasOwnProperty.call(body || {}, k);
  if (has('stitching_type')) {
    const raw = body.stitching_type;
    if (raw == null || String(raw).trim() === '') return [null, null];
    const t = String(raw).trim();
    if (!isValidStitchingType(t)) return [null, `stitching_type must be one of ${STITCHING_TYPES.join(', ')}, or empty`];
    return [t, null];
  }
  if (has('goes_to_stitching')) {
    return [body.goes_to_stitching ? (current?.stitching_type || FABRIC) : null, null];
  }
  return [current ? current.stitching_type : null, null];
}

// Receipts of this exact (category, item_name, unit_metric) triple that are
// lots on the Stitching page right now -- the same qualification LOTS_CTE
// applies: a live receipt with a stage, on a live line of a live PO. COLLATE
// NOCASE because the LOTS_CTE join compares against the master's NOCASE columns.
async function liveLotCount(product) {
  const { rows } = await db.execute({
    sql: `SELECT COUNT(*) AS n
            FROM outbound_po_line_receipts r
            JOIN outbound_po_lines l ON l.id = r.line_id AND l.deleted_at IS NULL
            JOIN outbound_pos p ON p.id = l.po_id AND p.status <> 'Deleted'
           WHERE r.deleted_at IS NULL
             AND (r.incoming_prefix_id IS NOT NULL OR r.direct_stage IS NOT NULL)
             AND l.category = ? COLLATE NOCASE AND l.item_name = ? COLLATE NOCASE
             AND l.unit_metric = ? COLLATE NOCASE`,
    args: [product.category, product.item_name, product.unit_metric],
  });
  return Number(rows[0]?.n) || 0;
}

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
        `SELECT p.id, p.category, p.item_name, p.unit_metric, p.is_active, p.goes_to_stitching,
                p.stitching_type, p.created_at, p.updated_at, u.name AS updated_by_name
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
    const [stitchingType, typeError] = resolveStitchingType(req.body);
    if (typeError) return res.status(400).json({ message: typeError });

    // goes_to_stitching is superseded by stitching_type (091) but kept in step,
    // the house rule for a column nothing reads any more.
    const { rows } = await db.execute({
      sql: `INSERT INTO outbound_products (category, item_name, unit_metric, stitching_type, goes_to_stitching,
              updated_by, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
            RETURNING id, category, item_name, unit_metric, is_active, stitching_type, goes_to_stitching,
                      created_at, updated_at`,
      args: [category, itemName, unitMetric, stitchingType, stitchingType ? 1 : 0, req.user.id],
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
      return res.status(409).json({ message: 'This category + item name + unit metric is already in the Outbound Product List' });
    }
    next(err);
  }
}

async function update(req, res, next) {
  try {
    const { id } = req.params;
    const has = (k) => Object.prototype.hasOwnProperty.call(req.body || {}, k);
    const { rows: existing } = await db.execute({
      sql: `SELECT id, category, item_name, unit_metric, is_active, stitching_type, goes_to_stitching
            FROM outbound_products WHERE id = ?`,
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

    // Whether this article travels the Stitching stages, and in which section.
    // Setting it is what makes a receipt of it demand a stage -- so it is a
    // master decision, not names baked into code.
    const [nextType, typeError] = resolveStitchingType(req.body, current);
    if (typeError) return res.status(400).json({ message: typeError });
    const nextStitching = nextType ? 1 : 0;

    // LOCKED while the article has lots on the Stitching page. Moving it between
    // Fabric and Readymade would carry every lot into the other section -- and a
    // Fabric lot at Processing into a section with no Processing tab -- and
    // clearing it would drop them off the page entirely. Setting a type on an
    // article that had none is always allowed: its older receipts carry no
    // stage, so they are not lots and stay where they are.
    if (current.stitching_type && nextType !== current.stitching_type) {
      const lots = await liveLotCount(current);
      if (lots > 0) {
        return res.status(409).json({
          message: `${current.item_name} has ${lots} lot${lots !== 1 ? 's' : ''} on the Stitching page — its type can't change`,
        });
      }
    }

    // Renaming the identity pair is cascaded onto every packaging product
    // onboarded under it (and, transitively, any vendor mapping onto those),
    // since both packaging_raw_materials and outbound_vendor_articles match
    // by this same text pair rather than by id. Casing-only corrections keep
    // matching either way, since the comparison is NOCASE.
    const counts = await loadUsageCounts();
    const usage = counts.get(pairKey(current.category, current.item_name)) || 0;
    const renamed = pairKey(nextCategory, nextItemName) !== pairKey(current.category, current.item_name);

    const changes = diffFields(
      current,
      {
        category: nextCategory, item_name: nextItemName, unit_metric: nextUnitMetric,
        is_active: nextActive, stitching_type: nextType, goes_to_stitching: nextStitching,
      },
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
                  stitching_type = ?, goes_to_stitching = ?, updated_by = ?, updated_at = datetime('now')
              WHERE id = ?
              RETURNING id, category, item_name, unit_metric, is_active, stitching_type, goes_to_stitching,
                        created_at, updated_at`,
        args: [nextCategory, nextItemName, nextUnitMetric, nextActive, nextType, nextStitching, req.user.id, id],
      });
      updated = rows[0];

      if (renamed) {
        // Cascade into vendor mappings first, while packaging_raw_materials
        // still holds the old exact-text pair to match against (its own
        // rename happens below, using the same OLD pair in its WHERE).
        const { rows: oldPairs } = await tx.execute({
          sql: `SELECT DISTINCT category, item_name FROM packaging_raw_materials
                WHERE LOWER(category) = LOWER(?) AND LOWER(item_name) = LOWER(?)`,
          args: [current.category, current.item_name],
        });
        for (const p of oldPairs) {
          await tx.execute({
            sql: `UPDATE outbound_vendor_articles SET category = ?, item_name = ?
                  WHERE category = ? AND item_name = ?`,
            args: [nextCategory, nextItemName, p.category, p.item_name],
          });
        }
      }

      if (renamed || metricChanged) {
        await tx.execute({
          sql: `UPDATE packaging_raw_materials
                SET category = ?, item_name = ?, unit_metric = ?, updated_by = ?, updated_at = datetime('now')
                WHERE LOWER(category) = LOWER(?) AND LOWER(item_name) = LOWER(?)`,
          args: [nextCategory, nextItemName, nextUnitMetric, req.user.id, current.category, current.item_name],
        });
      }

      await logAction({
        client: tx,
        userId: req.user.id,
        actionType: 'OUTBOUND_PRODUCT_UPDATE',
        description: `Updated outbound product ${nextCategory} / ${nextItemName}`
          + (renamed ? ` — renamed from ${current.category} / ${current.item_name}, applied to ${usage} packaging product${usage !== 1 ? 's' : ''}` : '')
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
      return res.status(409).json({ message: 'This category + item name + unit metric is already in the Outbound Product List' });
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
            WHERE id = ? RETURNING id, category, item_name, unit_metric, is_active, stitching_type, created_at, updated_at`,
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
