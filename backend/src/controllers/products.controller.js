const db = require('../config/db');
const { logAction, diffFields } = require('../services/auditLog.service');

const PRODUCT_FIELDS = ['sku_code', 'description', 'hsn_code', 'category'];
const BULK_LIMIT = 2000;

// ── helpers ──────────────────────────────────────────────────────────────────

function normText(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

// Validate + normalise a requirements array of { raw_product_id, qty }.
// Returns { ok: [{raw_product_id, qty}], error } — error set when invalid.
function normaliseRequirements(input, rawIdSet) {
  if (!Array.isArray(input) || input.length === 0) {
    return { error: 'At least one requirement (raw product + qty) is required' };
  }
  const seen = new Set();
  const ok = [];
  for (const r of input) {
    const rawId = Number(r?.raw_product_id);
    const qty = Number(r?.qty);
    if (!Number.isInteger(rawId) || !rawIdSet.has(rawId)) {
      return { error: `Unknown raw product (id ${r?.raw_product_id})` };
    }
    if (!Number.isInteger(qty) || qty <= 0) {
      return { error: 'Each requirement qty must be a positive integer' };
    }
    if (seen.has(rawId)) {
      return { error: 'A raw product appears more than once in requirements' };
    }
    seen.add(rawId);
    ok.push({ raw_product_id: rawId, qty });
  }
  return { ok };
}

async function loadRawIdSet() {
  const { rows } = await db.execute('SELECT id FROM raw_products');
  return new Set(rows.map(r => Number(r.id)));
}

async function fetchRequirementsByProduct(productIds) {
  if (!productIds.length) return new Map();
  const placeholders = productIds.map(() => '?').join(',');
  const { rows } = await db.execute({
    sql: `SELECT pr.product_id, pr.raw_product_id, pr.qty, rp.name
          FROM product_requirements pr
          JOIN raw_products rp ON rp.id = pr.raw_product_id
          WHERE pr.product_id IN (${placeholders})
          ORDER BY rp.name COLLATE NOCASE`,
    args: productIds,
  });
  const byProduct = new Map();
  for (const r of rows) {
    if (!byProduct.has(r.product_id)) byProduct.set(r.product_id, []);
    byProduct.get(r.product_id).push({ raw_product_id: r.raw_product_id, name: r.name, qty: r.qty });
  }
  return byProduct;
}

// ── handlers ─────────────────────────────────────────────────────────────────

async function list(req, res, next) {
  try {
    const { rows } = await db.execute(
      `SELECT p.id, p.sku_code, p.description, p.hsn_code, p.category,
              p.created_at, p.updated_at, u.name AS updated_by_name
       FROM products p
       LEFT JOIN users u ON u.id = p.updated_by
       ORDER BY p.created_at DESC`
    );
    const reqs = await fetchRequirementsByProduct(rows.map(r => r.id));
    for (const r of rows) r.requirements = reqs.get(r.id) || [];
    res.json(rows);
  } catch (err) { next(err); }
}

async function create(req, res, next) {
  try {
    const sku_code = normText(req.body.sku_code);
    if (!sku_code) return res.status(400).json({ message: 'sku_code is required' });

    const rawIdSet = await loadRawIdSet();
    const { ok: requirements, error } = normaliseRequirements(req.body.requirements, rawIdSet);
    if (error) return res.status(400).json({ message: error });

    const description = normText(req.body.description);
    const hsn_code = normText(req.body.hsn_code);
    const category = normText(req.body.category);

    const tx = await db.transaction('write');
    try {
      const { rows } = await tx.execute({
        sql: `INSERT INTO products (sku_code, description, hsn_code, category, updated_by, updated_at)
              VALUES (?, ?, ?, ?, ?, datetime('now')) RETURNING *`,
        args: [sku_code, description, hsn_code, category, req.user.id],
      });
      const product = rows[0];
      for (const r of requirements) {
        await tx.execute({
          sql: 'INSERT INTO product_requirements (product_id, raw_product_id, qty) VALUES (?, ?, ?)',
          args: [product.id, r.raw_product_id, r.qty],
        });
      }
      await logAction({
        client: tx,
        userId: req.user.id,
        actionType: 'PRODUCT_CREATE',
        description: `Created SKU ${sku_code} (${requirements.length} requirement${requirements.length !== 1 ? 's' : ''})`,
        entityType: 'product',
        entityId: product.id,
      });
      await tx.commit();
      res.status(201).json(product);
    } catch (e) {
      await tx.rollback();
      throw e;
    }
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
    const { rows: existing } = await db.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [id] });
    if (!existing.length) return res.status(404).json({ message: 'Product not found' });
    const current = existing[0];

    const sku_code = normText(req.body.sku_code) ?? current.sku_code;
    if (!sku_code) return res.status(400).json({ message: 'sku_code is required' });

    const rawIdSet = await loadRawIdSet();
    const { ok: requirements, error } = normaliseRequirements(req.body.requirements, rawIdSet);
    if (error) return res.status(400).json({ message: error });

    const description = normText(req.body.description);
    const hsn_code = normText(req.body.hsn_code);
    const category = normText(req.body.category);

    const tx = await db.transaction('write');
    try {
      const { rows } = await tx.execute({
        sql: `UPDATE products SET
                sku_code = ?, description = ?, hsn_code = ?, category = ?,
                updated_by = ?, updated_at = datetime('now')
              WHERE id = ? RETURNING *`,
        args: [sku_code, description, hsn_code, category, req.user.id, id],
      });
      await tx.execute({ sql: 'DELETE FROM product_requirements WHERE product_id = ?', args: [id] });
      for (const r of requirements) {
        await tx.execute({
          sql: 'INSERT INTO product_requirements (product_id, raw_product_id, qty) VALUES (?, ?, ?)',
          args: [id, r.raw_product_id, r.qty],
        });
      }
      const changes = diffFields(current, rows[0], PRODUCT_FIELDS);
      await logAction({
        client: tx,
        userId: req.user.id,
        actionType: 'PRODUCT_UPDATE',
        description: `Updated SKU ${rows[0].sku_code}`,
        entityType: 'product',
        entityId: id,
        changes,
      });
      await tx.commit();
      res.json(rows[0]);
    } catch (e) {
      await tx.rollback();
      throw e;
    }
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
    await logAction({ userId: req.user.id, actionType: 'PRODUCT_DELETE', description: `Deleted SKU ${rows[0].sku_code}`, entityType: 'product', entityId: id });
    res.json({ message: 'Product deleted' });
  } catch (err) { next(err); }
}

// Note: deleting a product cascade-deletes its product_requirements and product_vendor_codes.
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
        sql: `DELETE FROM products WHERE id IN (${placeholders}) RETURNING sku_code`,
        args: cleanIds,
      });
      await logAction({
        client: tx,
        userId: req.user.id,
        actionType: 'PRODUCT_BULK_DELETE',
        description: `Deleted ${rows.length} SKU${rows.length !== 1 ? 's' : ''}`,
        entityType: 'product',
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

// Parse a requirements cell like "Cotton Fabric Roll:2; Thread Spool:1" into
// [{ name, qty }]. Splits items on ';' and name/qty on the LAST ':'.
function parseRequirementsCell(cell) {
  const out = [];
  const errors = [];
  const items = String(cell || '').split(';').map(s => s.trim()).filter(Boolean);
  for (const item of items) {
    const idx = item.lastIndexOf(':');
    if (idx === -1) { errors.push(`"${item}" is missing ":qty"`); continue; }
    const name = item.slice(0, idx).trim();
    const qty = Number(item.slice(idx + 1).trim());
    if (!name) { errors.push(`"${item}" has no raw product name`); continue; }
    if (!Number.isInteger(qty) || qty <= 0) { errors.push(`"${item}" has an invalid qty`); continue; }
    out.push({ name, qty });
  }
  return { out, errors };
}

async function bulkUpsert(req, res, next) {
  try {
    const { rows: input } = req.body || {};
    if (!Array.isArray(input) || input.length === 0) {
      return res.status(400).json({ message: 'rows must be a non-empty array' });
    }
    if (input.length > BULK_LIMIT) {
      return res.status(400).json({ message: `Too many rows; max ${BULK_LIMIT}` });
    }

    const { rows: rawRows } = await db.execute('SELECT id, name FROM raw_products');
    const rawByName = new Map(rawRows.map(r => [String(r.name).trim().toLowerCase(), r.id]));

    const { rows: existing } = await db.execute('SELECT sku_code FROM products');
    const existingCodes = new Set(existing.map(e => String(e.sku_code).trim().toLowerCase()));

    const skipped = [];
    let inserted = 0;
    let updated = 0;

    for (let i = 0; i < input.length; i++) {
      const r = input[i] || {};
      const sku_code = normText(r.sku_code);
      if (!sku_code) { skipped.push({ row: i + 2, reason: 'Missing sku_code' }); continue; }

      const { out: parsed, errors } = parseRequirementsCell(r.requirements);
      if (errors.length) { skipped.push({ row: i + 2, reason: errors.join('; ') }); continue; }
      if (!parsed.length) { skipped.push({ row: i + 2, reason: 'No requirements provided' }); continue; }

      const requirements = [];
      let unknown = null;
      const seen = new Set();
      for (const p of parsed) {
        const rawId = rawByName.get(p.name.toLowerCase());
        if (!rawId) { unknown = p.name; break; }
        if (seen.has(rawId)) { unknown = `${p.name} (duplicated)`; break; }
        seen.add(rawId);
        requirements.push({ raw_product_id: rawId, qty: p.qty });
      }
      if (unknown) { skipped.push({ row: i + 2, reason: `Unknown raw product "${unknown}"` }); continue; }

      const isUpdate = existingCodes.has(sku_code.toLowerCase());
      const tx = await db.transaction('write');
      try {
        const { rows: up } = await tx.execute({
          sql: `INSERT INTO products (sku_code, description, hsn_code, category, updated_by, updated_at)
                VALUES (?, ?, ?, ?, ?, datetime('now'))
                ON CONFLICT(sku_code) DO UPDATE SET
                  description = excluded.description,
                  hsn_code = excluded.hsn_code,
                  category = excluded.category,
                  updated_by = excluded.updated_by,
                  updated_at = excluded.updated_at
                RETURNING id`,
          args: [sku_code, normText(r.description), normText(r.hsn_code), normText(r.category), req.user.id],
        });
        const productId = up[0].id;
        await tx.execute({ sql: 'DELETE FROM product_requirements WHERE product_id = ?', args: [productId] });
        for (const req2 of requirements) {
          await tx.execute({
            sql: 'INSERT INTO product_requirements (product_id, raw_product_id, qty) VALUES (?, ?, ?)',
            args: [productId, req2.raw_product_id, req2.qty],
          });
        }
        await tx.commit();
        if (isUpdate) updated++;
        else { inserted++; existingCodes.add(sku_code.toLowerCase()); }
      } catch (e) {
        await tx.rollback();
        skipped.push({ row: i + 2, reason: e.message || 'DB error' });
      }
    }

    await logAction({
      userId: req.user.id,
      actionType: 'PRODUCT_BULK_UPSERT',
      description: `Bulk: +${inserted} inserted, ~${updated} updated, !${skipped.length} skipped`,
      entityType: 'product',
      entityId: null,
    });

    res.json({ inserted, updated, skipped });
  } catch (err) { next(err); }
}

module.exports = { list, create, update, remove, bulkDelete, bulkUpsert };
