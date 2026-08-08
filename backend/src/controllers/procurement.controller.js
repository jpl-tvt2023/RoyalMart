const db = require('../config/db');
const { logAction } = require('../services/auditLog.service');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Build the shared "in scope" WHERE for not-yet-ordered POs, optionally bounded
// by po_date. Returns { where, args } with `po` as the marketplace_pos alias.
// batchColumn selects which "ordered" flag defines the scope — raw-material
// ordering (procurement_batch_id, the default) or packaging ordering
// (packaging_procurement_batch_id) — always one of these two hardcoded
// literals from this file, never request input, so interpolating it is safe.
function scopeWhere({ po_date_from, po_date_to, vendor, po_ids }, batchColumn = 'procurement_batch_id') {
  const conditions = [`po.${batchColumn} IS NULL`, "po.status <> 'Deleted'"];
  const args = [];
  if (po_date_from && DATE_RE.test(po_date_from)) { conditions.push('po.po_date >= ?'); args.push(po_date_from); }
  if (po_date_to && DATE_RE.test(po_date_to))     { conditions.push('po.po_date <= ?'); args.push(po_date_to); }
  if (vendor) { conditions.push('po.vendor = ?'); args.push(vendor); }
  // Explicit selection: restrict to these PO ids. The not-yet-ordered / not-deleted
  // guards above still apply, so already-ordered or deleted ids are silently skipped.
  if (Array.isArray(po_ids) && po_ids.length) {
    conditions.push(`po.po_id IN (${po_ids.map(() => '?').join(',')})`);
    args.push(...po_ids);
  }
  return { where: conditions.join(' AND '), args };
}

// Date-range WHERE over po_date only (no ordered filter) — the matrix shows
// every PO in range, ordered or not. An optional `vendor` narrows the matrix to
// a single vendor's POs (the per-vendor tabs); omit it for the "All" master view.
// Returns { where, args }.
function rangeWhere({ po_date_from, po_date_to, vendor }) {
  const conditions = ["po.status <> 'Deleted'"];
  const args = [];
  if (po_date_from && DATE_RE.test(po_date_from)) { conditions.push('po.po_date >= ?'); args.push(po_date_from); }
  if (po_date_to && DATE_RE.test(po_date_to))     { conditions.push('po.po_date <= ?'); args.push(po_date_to); }
  if (vendor) { conditions.push('po.vendor = ?'); args.push(vendor); }
  conditions.push('po.po_date IS NOT NULL');
  return { where: conditions.join(' AND '), args };
}

// Default PO-date-from for the UI: day after the latest already-ordered PO,
// else the earliest PO date, else null.
async function getDefaults(req, res, next) {
  try {
    const { rows } = await db.execute(
      `SELECT
         (SELECT date(MAX(po_date), '+1 day') FROM marketplace_pos WHERE procurement_batch_id IS NOT NULL AND po_date IS NOT NULL AND status <> 'Deleted') AS after_last_ordered,
         (SELECT MIN(po_date) FROM marketplace_pos WHERE po_date IS NOT NULL AND status <> 'Deleted') AS earliest`
    );
    res.json({ po_date_from: rows[0]?.after_last_ordered || rows[0]?.earliest || null });
  } catch (err) { next(err); }
}

async function getRequirements(req, res, next) {
  try {
    const { where, args } = rangeWhere(req.query);

    const [{ rows: posRows }, { rows: cellRows }, { rows: allRawRows }, { rows: unmappedRows }, { rows: unmappedSamples }] = await Promise.all([
      // Every PO in the date range, with its ordered flag.
      db.execute({
        sql: `SELECT po.po_id, po.po_date, po.vendor,
                     CASE WHEN po.procurement_batch_id IS NOT NULL THEN 1 ELSE 0 END AS ordered
              FROM marketplace_pos po
              WHERE ${where}
              ORDER BY po.po_date, po.po_id`,
        args,
      }),
      // Per (raw product, PO) required qty across the range.
      db.execute({
        sql: `SELECT rp.id AS raw_product_id, po.po_id, SUM(l.qty * preq.qty) AS qty
              FROM marketplace_pos po
              JOIN marketplace_po_lines l    ON l.po_id = po.po_id
              JOIN product_vendor_codes pvc  ON pvc.vendor = po.vendor AND pvc.vendor_item_code = l.item_code
              JOIN products p                ON p.id = pvc.product_id
              JOIN product_requirements preq ON preq.product_id = p.id
              JOIN raw_products rp           ON rp.id = preq.raw_product_id
              WHERE ${where}
              GROUP BY rp.id, po.po_id`,
        args,
      }),
      // Full raw-product roster so every raw product is listed (0 when nothing requires it).
      db.execute('SELECT id, name FROM raw_products ORDER BY name COLLATE NOCASE'),
      // Lines in range that don't expand to any raw product (no mapping, or SKU without requirements).
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
        sql: `SELECT DISTINCT po.vendor, l.item_code, po.po_id, po.vendor_po_id
              FROM marketplace_pos po
              JOIN marketplace_po_lines l ON l.po_id = po.po_id
              LEFT JOIN product_vendor_codes pvc ON pvc.vendor = po.vendor AND pvc.vendor_item_code = l.item_code
              LEFT JOIN product_requirements preq ON preq.product_id = pvc.product_id
              WHERE ${where} AND preq.id IS NULL
              ORDER BY po.po_id, l.item_code
              LIMIT 50`,
        args,
      }),
    ]);

    const pos = posRows.map(p => ({ po_id: p.po_id, po_date: p.po_date, vendor: p.vendor, ordered: !!p.ordered }));
    const orderedSet = new Set(pos.filter(p => p.ordered).map(p => p.po_id));
    const poCount = pos.filter(p => !p.ordered).length;

    // raw_product_id -> { [po_id]: qty }
    const cellsByRaw = new Map();
    for (const c of cellRows) {
      if (!cellsByRaw.has(c.raw_product_id)) cellsByRaw.set(c.raw_product_id, {});
      cellsByRaw.get(c.raw_product_id)[c.po_id] = Number(c.qty) || 0;
    }

    const raw_products = allRawRows.map(r => {
      const quantities = cellsByRaw.get(r.id) || {};
      let total = 0;
      for (const [poId, qty] of Object.entries(quantities)) {
        if (!orderedSet.has(poId)) total += qty;
      }
      return { raw_product_id: r.id, name: r.name, total_required_qty: total, quantities };
    });

    res.json({
      pos,
      raw_products,
      po_count: poCount,
      unmapped_line_count: Number(unmappedRows[0]?.n) || 0,
      unmapped_samples: unmappedSamples.map(s => ({
        vendor: s.vendor,
        item_code: s.item_code,
        po_id: s.po_id,
        vendor_po_id: s.vendor_po_id,
      })),
    });
  } catch (err) { next(err); }
}

// Per-vendor count of not-yet-ordered POs in the date range (drives the vendor
// tab badges). Vendor-agnostic scope so every tab shows its own count at once;
// the "All" key is the grand total.
async function getVendorCounts(req, res, next) {
  try {
    const { where, args } = scopeWhere({
      po_date_from: req.query.po_date_from,
      po_date_to: req.query.po_date_to,
    });
    const { rows } = await db.execute({
      sql: `SELECT po.vendor AS vendor, COUNT(*) AS n
            FROM marketplace_pos po
            WHERE ${where} AND po.po_date IS NOT NULL
            GROUP BY po.vendor`,
      args,
    });
    const counts = {};
    let all = 0;
    for (const r of rows) {
      const n = Number(r.n) || 0;
      counts[r.vendor] = n;
      all += n;
    }
    counts.All = all;
    res.json({ counts });
  } catch (err) { next(err); }
}

async function markOrdered(req, res, next) {
  try {
    const { po_date_from, po_date_to, note, vendor, po_ids } = req.body || {};
    if (po_date_from && !DATE_RE.test(po_date_from)) return res.status(400).json({ message: 'Invalid po_date_from (YYYY-MM-DD)' });
    if (po_date_to && !DATE_RE.test(po_date_to))     return res.status(400).json({ message: 'Invalid po_date_to (YYYY-MM-DD)' });
    if (!Array.isArray(po_ids) || po_ids.length === 0) {
      return res.status(400).json({ message: 'Select at least one PO to mark as ordered' });
    }

    const { where, args } = scopeWhere({ po_date_from, po_date_to, vendor, po_ids });
    const { rows: targets } = await db.execute({
      sql: `SELECT po.po_id FROM marketplace_pos po WHERE ${where}`,
      args,
    });
    if (!targets.length) return res.status(400).json({ message: 'None of the selected POs are pending' });
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

// ── Outbound (packaging/barcode demand) ─────────────────────────────────────
//
// Mirrors the Inbound raw-material flow above, but explodes marketplace PO
// lines into packaging/barcode article demand (product_packaging_requirements
// UNION ALL product_barcode_requirements -> packaging_raw_materials) instead
// of raw-material demand, and tracks "ordered" independently via
// packaging_procurement_batch_id/packaging_ordered_at so a PO can be
// raw-ordered and packaging-ordered on separate schedules.
//
// Unlike Inbound's vendor tabs (which change the PO set in scope), the
// Outbound UI's item-name tabs only filter which rows are *displayed* — one
// PO's demand can span many item names at once, so the PO set/stats are the
// same regardless of which tab is active. That's why there's no vendor/tab
// query param here: one call always returns the full article roster, and the
// item-name tabs are derived client-side, same as Inbound's raw_products roster
// is always returned in full regardless of which vendor tab is selected.

async function getOutboundDefaults(req, res, next) {
  try {
    const { rows } = await db.execute(
      `SELECT
         (SELECT date(MAX(po_date), '+1 day') FROM marketplace_pos WHERE packaging_procurement_batch_id IS NOT NULL AND po_date IS NOT NULL AND status <> 'Deleted') AS after_last_ordered,
         (SELECT MIN(po_date) FROM marketplace_pos WHERE po_date IS NOT NULL AND status <> 'Deleted') AS earliest`
    );
    res.json({ po_date_from: rows[0]?.after_last_ordered || rows[0]?.earliest || null });
  } catch (err) { next(err); }
}

async function getOutboundRequirements(req, res, next) {
  try {
    const { where, args } = rangeWhere(req.query);

    const [{ rows: posRows }, { rows: cellRows }, { rows: allArticleRows }, { rows: unmappedRows }, { rows: unmappedSamples }] = await Promise.all([
      // Every PO in the date range, with its packaging-ordered flag.
      db.execute({
        sql: `SELECT po.po_id, po.po_date, po.vendor,
                     CASE WHEN po.packaging_procurement_batch_id IS NOT NULL THEN 1 ELSE 0 END AS ordered
              FROM marketplace_pos po
              WHERE ${where}
              ORDER BY po.po_date, po.po_id`,
        args,
      }),
      // Per (packaging/barcode article, PO) required qty across the range.
      db.execute({
        sql: `SELECT prm.id AS packaging_raw_material_id, po.po_id, SUM(l.qty * areq.qty) AS qty
              FROM marketplace_pos po
              JOIN marketplace_po_lines l    ON l.po_id = po.po_id
              JOIN product_vendor_codes pvc  ON pvc.vendor = po.vendor AND pvc.vendor_item_code = l.item_code
              JOIN products p                ON p.id = pvc.product_id
              JOIN (
                SELECT product_id, packaging_raw_material_id, qty FROM product_packaging_requirements
                UNION ALL
                SELECT product_id, packaging_raw_material_id, qty FROM product_barcode_requirements
              ) areq ON areq.product_id = p.id
              JOIN packaging_raw_materials prm ON prm.id = areq.packaging_raw_material_id
              WHERE ${where}
              GROUP BY prm.id, po.po_id`,
        args,
      }),
      // Full packaging+barcode article roster so every article is listed (0 when nothing requires it).
      db.execute(
        `SELECT id, category, item_name, variant, unit_metric
         FROM packaging_raw_materials
         WHERE category IN ('Packaging','Barcode') COLLATE NOCASE
         ORDER BY item_name COLLATE NOCASE, variant COLLATE NOCASE`
      ),
      // Lines in range that don't expand to any packaging/barcode requirement
      // (no vendor mapping, or a SKU without those requirements yet).
      db.execute({
        sql: `SELECT COUNT(*) AS n
              FROM marketplace_pos po
              JOIN marketplace_po_lines l ON l.po_id = po.po_id
              LEFT JOIN product_vendor_codes pvc ON pvc.vendor = po.vendor AND pvc.vendor_item_code = l.item_code
              LEFT JOIN (
                SELECT product_id FROM product_packaging_requirements
                UNION
                SELECT product_id FROM product_barcode_requirements
              ) areq ON areq.product_id = pvc.product_id
              WHERE ${where} AND areq.product_id IS NULL`,
        args,
      }),
      db.execute({
        sql: `SELECT DISTINCT po.vendor, l.item_code, po.po_id, po.vendor_po_id
              FROM marketplace_pos po
              JOIN marketplace_po_lines l ON l.po_id = po.po_id
              LEFT JOIN product_vendor_codes pvc ON pvc.vendor = po.vendor AND pvc.vendor_item_code = l.item_code
              LEFT JOIN (
                SELECT product_id FROM product_packaging_requirements
                UNION
                SELECT product_id FROM product_barcode_requirements
              ) areq ON areq.product_id = pvc.product_id
              WHERE ${where} AND areq.product_id IS NULL
              ORDER BY po.po_id, l.item_code
              LIMIT 50`,
        args,
      }),
    ]);

    const pos = posRows.map(p => ({ po_id: p.po_id, po_date: p.po_date, vendor: p.vendor, ordered: !!p.ordered }));
    const orderedSet = new Set(pos.filter(p => p.ordered).map(p => p.po_id));
    const poCount = pos.filter(p => !p.ordered).length;

    // packaging_raw_material_id -> { [po_id]: qty }
    const cellsByArticle = new Map();
    for (const c of cellRows) {
      if (!cellsByArticle.has(c.packaging_raw_material_id)) cellsByArticle.set(c.packaging_raw_material_id, {});
      cellsByArticle.get(c.packaging_raw_material_id)[c.po_id] = Number(c.qty) || 0;
    }

    const articles = allArticleRows.map(a => {
      const quantities = cellsByArticle.get(a.id) || {};
      let total = 0;
      for (const [poId, qty] of Object.entries(quantities)) {
        if (!orderedSet.has(poId)) total += qty;
      }
      return {
        packaging_raw_material_id: a.id,
        category: a.category,
        item_name: a.item_name,
        variant: a.variant || null,
        unit_metric: a.unit_metric,
        total_required_qty: total,
        quantities,
      };
    });

    res.json({
      pos,
      articles,
      po_count: poCount,
      unmapped_line_count: Number(unmappedRows[0]?.n) || 0,
      unmapped_samples: unmappedSamples.map(s => ({
        vendor: s.vendor,
        item_code: s.item_code,
        po_id: s.po_id,
        vendor_po_id: s.vendor_po_id,
      })),
    });
  } catch (err) { next(err); }
}

async function markPackagingOrdered(req, res, next) {
  try {
    const { po_date_from, po_date_to, note, vendor, po_ids } = req.body || {};
    if (po_date_from && !DATE_RE.test(po_date_from)) return res.status(400).json({ message: 'Invalid po_date_from (YYYY-MM-DD)' });
    if (po_date_to && !DATE_RE.test(po_date_to))     return res.status(400).json({ message: 'Invalid po_date_to (YYYY-MM-DD)' });
    if (!Array.isArray(po_ids) || po_ids.length === 0) {
      return res.status(400).json({ message: 'Select at least one PO to mark as packaging-ordered' });
    }

    const { where, args } = scopeWhere({ po_date_from, po_date_to, vendor, po_ids }, 'packaging_procurement_batch_id');
    const { rows: targets } = await db.execute({
      sql: `SELECT po.po_id FROM marketplace_pos po WHERE ${where}`,
      args,
    });
    if (!targets.length) return res.status(400).json({ message: 'None of the selected POs are pending' });
    const poIds = targets.map(t => t.po_id);

    const tx = await db.transaction('write');
    try {
      const { rows: batchRows } = await tx.execute({
        sql: `INSERT INTO procurement_packaging_batches (po_date_from, po_date_to, po_count, note, created_by)
              VALUES (?, ?, ?, ?, ?) RETURNING id`,
        args: [po_date_from || null, po_date_to || null, poIds.length, (note && String(note).trim()) || null, req.user.id],
      });
      const batchId = batchRows[0].id;
      const placeholders = poIds.map(() => '?').join(',');
      await tx.execute({
        sql: `UPDATE marketplace_pos
              SET packaging_procurement_batch_id = ?, packaging_ordered_at = datetime('now')
              WHERE po_id IN (${placeholders})`,
        args: [batchId, ...poIds],
      });
      await logAction({
        client: tx,
        userId: req.user.id,
        actionType: 'PROCUREMENT_PACKAGING_MARK_ORDERED',
        description: `Marked ${poIds.length} PO(s) as packaging-ordered${po_date_from || po_date_to ? ` (${po_date_from || '…'} – ${po_date_to || '…'})` : ''}`,
        entityType: 'procurement_packaging_batch',
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

async function listPackagingBatches(req, res, next) {
  try {
    const { rows } = await db.execute(
      `SELECT b.id, b.po_date_from, b.po_date_to, b.po_count, b.note, b.created_at,
              u.name AS created_by_name
       FROM procurement_packaging_batches b
       LEFT JOIN users u ON u.id = b.created_by
       ORDER BY b.created_at DESC
       LIMIT 50`
    );
    res.json(rows);
  } catch (err) { next(err); }
}

async function undoPackagingBatch(req, res, next) {
  try {
    const { id } = req.params;
    const { rows: existing } = await db.execute({ sql: 'SELECT id, po_count FROM procurement_packaging_batches WHERE id = ?', args: [id] });
    if (!existing.length) return res.status(404).json({ message: 'Batch not found' });

    const tx = await db.transaction('write');
    try {
      await tx.execute({
        sql: `UPDATE marketplace_pos SET packaging_procurement_batch_id = NULL, packaging_ordered_at = NULL WHERE packaging_procurement_batch_id = ?`,
        args: [id],
      });
      await tx.execute({ sql: 'DELETE FROM procurement_packaging_batches WHERE id = ?', args: [id] });
      await logAction({
        client: tx,
        userId: req.user.id,
        actionType: 'PROCUREMENT_PACKAGING_UNDO',
        description: `Undid packaging procurement batch #${id} (${existing[0].po_count} PO(s) returned to pending)`,
        entityType: 'procurement_packaging_batch',
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

module.exports = {
  getDefaults, getRequirements, getVendorCounts, markOrdered, listBatches, undoBatch,
  getOutboundDefaults, getOutboundRequirements, markPackagingOrdered, listPackagingBatches, undoPackagingBatch,
};
