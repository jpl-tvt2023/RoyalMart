const db = require('../config/db');
const { logAction } = require('../services/auditLog.service');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Build the shared "in scope" WHERE for not-yet-ordered POs, optionally bounded
// by po_date. Returns { where, args } with `po` as the marketplace_pos alias.
function scopeWhere({ po_date_from, po_date_to }) {
  const conditions = ['po.procurement_batch_id IS NULL'];
  const args = [];
  if (po_date_from && DATE_RE.test(po_date_from)) { conditions.push('po.po_date >= ?'); args.push(po_date_from); }
  if (po_date_to && DATE_RE.test(po_date_to))     { conditions.push('po.po_date <= ?'); args.push(po_date_to); }
  return { where: conditions.join(' AND '), args };
}

async function getRequirements(req, res, next) {
  try {
    const { where, args } = scopeWhere(req.query);

    const [{ rows: rawRows }, { rows: summaryRows }, { rows: unmappedRows }, { rows: unmappedSamples }] = await Promise.all([
      db.execute({
        sql: `SELECT rp.id AS raw_product_id, rp.name, SUM(l.qty * preq.qty) AS required_qty
              FROM marketplace_pos po
              JOIN marketplace_po_lines l    ON l.po_id = po.po_id
              JOIN product_vendor_codes pvc  ON pvc.vendor = po.vendor AND pvc.vendor_item_code = l.item_code
              JOIN products p                ON p.id = pvc.product_id
              JOIN product_requirements preq ON preq.product_id = p.id
              JOIN raw_products rp           ON rp.id = preq.raw_product_id
              WHERE ${where}
              GROUP BY rp.id, rp.name
              ORDER BY rp.name COLLATE NOCASE`,
        args,
      }),
      db.execute({
        sql: `SELECT COUNT(*) AS po_count, MIN(po.po_date) AS date_min, MAX(po.po_date) AS date_max
              FROM marketplace_pos po
              WHERE ${where}`,
        args,
      }),
      // Lines in scope that don't expand to any raw product (no mapping, or SKU without requirements).
      db.execute({
        sql: `SELECT COUNT(*) AS n
              FROM marketplace_pos po
              JOIN marketplace_po_lines l ON l.po_id = po.po_id
              LEFT JOIN product_vendor_codes pvc ON pvc.vendor = po.vendor AND pvc.vendor_item_code = l.item_code
              LEFT JOIN product_requirements preq ON preq.product_id = pvc.product_id
              WHERE ${where} AND preq.id IS NULL`,
        args,
      }),
      db.execute({
        sql: `SELECT DISTINCT po.vendor, l.item_code
              FROM marketplace_pos po
              JOIN marketplace_po_lines l ON l.po_id = po.po_id
              LEFT JOIN product_vendor_codes pvc ON pvc.vendor = po.vendor AND pvc.vendor_item_code = l.item_code
              LEFT JOIN product_requirements preq ON preq.product_id = pvc.product_id
              WHERE ${where} AND preq.id IS NULL
              LIMIT 10`,
        args,
      }),
    ]);

    res.json({
      raw_products: rawRows.map(r => ({ raw_product_id: r.raw_product_id, name: r.name, required_qty: Number(r.required_qty) || 0 })),
      po_count: Number(summaryRows[0]?.po_count) || 0,
      date_min: summaryRows[0]?.date_min || null,
      date_max: summaryRows[0]?.date_max || null,
      unmapped_line_count: Number(unmappedRows[0]?.n) || 0,
      unmapped_samples: unmappedSamples.map(s => ({ vendor: s.vendor, item_code: s.item_code })),
    });
  } catch (err) { next(err); }
}

async function markOrdered(req, res, next) {
  try {
    const { po_date_from, po_date_to, note } = req.body || {};
    if (po_date_from && !DATE_RE.test(po_date_from)) return res.status(400).json({ message: 'Invalid po_date_from (YYYY-MM-DD)' });
    if (po_date_to && !DATE_RE.test(po_date_to))     return res.status(400).json({ message: 'Invalid po_date_to (YYYY-MM-DD)' });

    const { where, args } = scopeWhere({ po_date_from, po_date_to });
    const { rows: targets } = await db.execute({
      sql: `SELECT po.po_id FROM marketplace_pos po WHERE ${where}`,
      args,
    });
    if (!targets.length) return res.status(400).json({ message: 'No pending POs in that range' });
    const poIds = targets.map(t => t.po_id);

    const tx = await db.transaction('write');
    try {
      const { rows: batchRows } = await tx.execute({
        sql: `INSERT INTO procurement_batches (po_date_from, po_date_to, po_count, note, created_by)
              VALUES (?, ?, ?, ?, ?) RETURNING id`,
        args: [po_date_from || null, po_date_to || null, poIds.length, (note && String(note).trim()) || null, req.user.id],
      });
      const batchId = batchRows[0].id;
      const placeholders = poIds.map(() => '?').join(',');
      await tx.execute({
        sql: `UPDATE marketplace_pos
              SET procurement_batch_id = ?, raw_ordered_at = datetime('now')
              WHERE po_id IN (${placeholders})`,
        args: [batchId, ...poIds],
      });
      await logAction({
        client: tx,
        userId: req.user.id,
        actionType: 'PROCUREMENT_MARK_ORDERED',
        description: `Marked ${poIds.length} PO(s) as raw-ordered${po_date_from || po_date_to ? ` (${po_date_from || '…'} – ${po_date_to || '…'})` : ''}`,
        entityType: 'procurement_batch',
        entityId: batchId,
      });
      await tx.commit();
      res.status(201).json({ batch_id: batchId, po_count: poIds.length });
    } catch (e) {
      await tx.rollback();
      throw e;
    }
  } catch (err) { next(err); }
}

async function listBatches(req, res, next) {
  try {
    const { rows } = await db.execute(
      `SELECT b.id, b.po_date_from, b.po_date_to, b.po_count, b.note, b.created_at,
              u.name AS created_by_name
       FROM procurement_batches b
       LEFT JOIN users u ON u.id = b.created_by
       ORDER BY b.created_at DESC
       LIMIT 50`
    );
    res.json(rows);
  } catch (err) { next(err); }
}

async function undoBatch(req, res, next) {
  try {
    const { id } = req.params;
    const { rows: existing } = await db.execute({ sql: 'SELECT id, po_count FROM procurement_batches WHERE id = ?', args: [id] });
    if (!existing.length) return res.status(404).json({ message: 'Batch not found' });

    const tx = await db.transaction('write');
    try {
      await tx.execute({
        sql: `UPDATE marketplace_pos SET procurement_batch_id = NULL, raw_ordered_at = NULL WHERE procurement_batch_id = ?`,
        args: [id],
      });
      await tx.execute({ sql: 'DELETE FROM procurement_batches WHERE id = ?', args: [id] });
      await logAction({
        client: tx,
        userId: req.user.id,
        actionType: 'PROCUREMENT_UNDO',
        description: `Undid procurement batch #${id} (${existing[0].po_count} PO(s) returned to pending)`,
        entityType: 'procurement_batch',
        entityId: id,
      });
      await tx.commit();
      res.json({ undone: true, po_count: existing[0].po_count });
    } catch (e) {
      await tx.rollback();
      throw e;
    }
  } catch (err) { next(err); }
}

module.exports = { getRequirements, markOrdered, listBatches, undoBatch };
