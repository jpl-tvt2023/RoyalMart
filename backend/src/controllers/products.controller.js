const db = require('../config/db');
const { logAction, diffFields } = require('../services/auditLog.service');

const PRODUCT_FIELDS = ['sku_code', 'description', 'category'];
const BULK_LIMIT = 2000;

// ── helpers ──────────────────────────────────────────────────────────────────

function normText(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

// Validate + normalise a requirements array of { [idField]: id, qty }.
// Shared by all three requirement sections (raw product, packaging, barcode) —
// idSet decides which ids are legal, idField/label decide the id key and the
// wording of any error. Returns { ok: [{[idField]: id, qty}], error }.
function normaliseRequirementRows(input, idSet, idField, label) {
  if (!Array.isArray(input) || input.length === 0) {
    return { error: `At least one ${label} requirement (${label} + qty) is required` };
  }
  const seen = new Set();
  const ok = [];
  for (const r of input) {
    const id = Number(r?.[idField]);
    const qty = Number(r?.qty);
    if (!Number.isInteger(id) || !idSet.has(id)) {
      return { error: `Unknown ${label} (id ${r?.[idField]})` };
    }
    if (!Number.isInteger(qty) || qty <= 0) {
      return { error: `Each ${label} requirement qty must be a positive integer` };
    }
    if (seen.has(id)) {
      return { error: `A ${label} appears more than once in requirements` };
    }
    seen.add(id);
    ok.push({ [idField]: id, qty });
  }
  return { ok };
}

async function loadRawIdSet() {
  const { rows } = await db.execute('SELECT id FROM raw_products');
  return new Set(rows.map(r => Number(r.id)));
}

// Packaging Product requirements may only reference catalog articles under
// category = 'Packaging'; Barcode requirements only under category = 'Barcode'.
// Handing normaliseRequirementRows the right set is what keeps a Barcode
// article from being saved as a Packaging requirement (or vice versa).
async function loadPackagingArticleIdSets() {
  const { rows } = await db.execute(
    "SELECT id, category FROM packaging_raw_materials WHERE category IN ('Packaging','Barcode') COLLATE NOCASE"
  );
  const packagingIds = new Set();
  const barcodeIds = new Set();
  for (const r of rows) {
    const cat = String(r.category).toLowerCase();
    if (cat === 'packaging') packagingIds.add(Number(r.id));
    else if (cat === 'barcode') barcodeIds.add(Number(r.id));
  }
  return { packagingIds, barcodeIds };
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

// Packaging/Barcode requirement fetch, generalised over which join table to
// read. tableName is always one of two hardcoded literals passed by this file
// (never request input), so string interpolation into the SQL is safe.
async function fetchArticleRequirementsByProduct(productIds, tableName) {
  if (!productIds.length) return new Map();
  const placeholders = productIds.map(() => '?').join(',');
  const { rows } = await db.execute({
    sql: `SELECT t.product_id, t.packaging_raw_material_id, t.qty, prm.category, prm.item_name, prm.variant, prm.unit_metric
          FROM ${tableName} t
          JOIN packaging_raw_materials prm ON prm.id = t.packaging_raw_material_id
          WHERE t.product_id IN (${placeholders})
          ORDER BY prm.item_name COLLATE NOCASE, prm.variant COLLATE NOCASE`,
    args: productIds,
  });
  const byProduct = new Map();
  for (const r of rows) {
    if (!byProduct.has(r.product_id)) byProduct.set(r.product_id, []);
    byProduct.get(r.product_id).push({
      packaging_raw_material_id: r.packaging_raw_material_id,
      category: r.category,
      item_name: r.item_name,
      variant: r.variant || null,
      unit_metric: r.unit_metric,
      qty: r.qty,
    });
  }
  return byProduct;
}

// ── handlers ─────────────────────────────────────────────────────────────────

async function list(req, res, next) {
  try {
    const { rows } = await db.execute(
      `SELECT p.id, p.sku_code, p.description, p.category,
              p.created_at, p.updated_at, u.name AS updated_by_name
       FROM products p
       LEFT JOIN users u ON u.id = p.updated_by
       ORDER BY p.created_at DESC`
    );
    const ids = rows.map(r => r.id);
    const [reqs, packagingReqs, barcodeReqs] = await Promise.all([
      fetchRequirementsByProduct(ids),
      fetchArticleRequirementsByProduct(ids, 'product_packaging_requirements'),
      fetchArticleRequirementsByProduct(ids, 'product_barcode_requirements'),
    ]);
    for (const r of rows) {
      r.requirements = reqs.get(r.id) || [];
      r.packaging_requirements = packagingReqs.get(r.id) || [];
      r.barcode_requirements = barcodeReqs.get(r.id) || [];
    }
    res.json(rows);
  } catch (err) { next(err); }
}

async function create(req, res, next) {
  try {
    const sku_code = normText(req.body.sku_code);
    if (!sku_code) return res.status(400).json({ message: 'sku_code is required' });

    const [rawIdSet, { packagingIds, barcodeIds }] = await Promise.all([
      loadRawIdSet(),
      loadPackagingArticleIdSets(),
    ]);
    const { ok: requirements, error: reqError } =
      normaliseRequirementRows(req.body.requirements, rawIdSet, 'raw_product_id', 'raw product');
    if (reqError) return res.status(400).json({ message: reqError });
    const { ok: packagingRequirements, error: pkgError } =
      normaliseRequirementRows(req.body.packaging_requirements, packagingIds, 'packaging_raw_material_id', 'packaging product');
    if (pkgError) return res.status(400).json({ message: pkgError });
    const { ok: barcodeRequirements, error: bcError } =
      normaliseRequirementRows(req.body.barcode_requirements, barcodeIds, 'packaging_raw_material_id', 'barcode');
    if (bcError) return res.status(400).json({ message: bcError });

    const description = normText(req.body.description);
    const category = normText(req.body.category);

    const tx = await db.transaction('write');
    try {
      const { rows } = await tx.execute({
        sql: `INSERT INTO products (sku_code, description, category, updated_by, updated_at)
              VALUES (?, ?, ?, ?, datetime('now')) RETURNING *`,
        args: [sku_code, description, category, req.user.id],
      });
      const product = rows[0];
      for (const r of requirements) {
        await tx.execute({
          sql: 'INSERT INTO product_requirements (product_id, raw_product_id, qty) VALUES (?, ?, ?)',
          args: [product.id, r.raw_product_id, r.qty],
        });
      }
      for (const r of packagingRequirements) {
        await tx.execute({
          sql: 'INSERT INTO product_packaging_requirements (product_id, packaging_raw_material_id, qty) VALUES (?, ?, ?)',
          args: [product.id, r.packaging_raw_material_id, r.qty],
        });
      }
      for (const r of barcodeRequirements) {
        await tx.execute({
          sql: 'INSERT INTO product_barcode_requirements (product_id, packaging_raw_material_id, qty) VALUES (?, ?, ?)',
          args: [product.id, r.packaging_raw_material_id, r.qty],
        });
      }
      await logAction({
        client: tx,
        userId: req.user.id,
        actionType: 'PRODUCT_CREATE',
        description: `Created SKU ${sku_code} (${requirements.length} raw, ${packagingRequirements.length} packaging, ${barcodeRequirements.length} barcode requirement${(requirements.length + packagingRequirements.length + barcodeRequirements.length) !== 1 ? 's' : ''})`,
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

    const [rawIdSet, { packagingIds, barcodeIds }] = await Promise.all([
      loadRawIdSet(),
      loadPackagingArticleIdSets(),
    ]);
    const { ok: requirements, error: reqError } =
      normaliseRequirementRows(req.body.requirements, rawIdSet, 'raw_product_id', 'raw product');
    if (reqError) return res.status(400).json({ message: reqError });
    const { ok: packagingRequirements, error: pkgError } =
      normaliseRequirementRows(req.body.packaging_requirements, packagingIds, 'packaging_raw_material_id', 'packaging product');
    if (pkgError) return res.status(400).json({ message: pkgError });
    const { ok: barcodeRequirements, error: bcError } =
      normaliseRequirementRows(req.body.barcode_requirements, barcodeIds, 'packaging_raw_material_id', 'barcode');
    if (bcError) return res.status(400).json({ message: bcError });

    const description = normText(req.body.description);
    const category = normText(req.body.category);

    const tx = await db.transaction('write');
    try {
      const { rows } = await tx.execute({
        sql: `UPDATE products SET
                sku_code = ?, description = ?, category = ?,
                updated_by = ?, updated_at = datetime('now')
              WHERE id = ? RETURNING *`,
        args: [sku_code, description, category, req.user.id, id],
      });
      await tx.execute({ sql: 'DELETE FROM product_requirements WHERE product_id = ?', args: [id] });
      for (const r of requirements) {
        await tx.execute({
          sql: 'INSERT INTO product_requirements (product_id, raw_product_id, qty) VALUES (?, ?, ?)',
          args: [id, r.raw_product_id, r.qty],
        });
      }
      await tx.execute({ sql: 'DELETE FROM product_packaging_requirements WHERE product_id = ?', args: [id] });
      for (const r of packagingRequirements) {
        await tx.execute({
          sql: 'INSERT INTO product_packaging_requirements (product_id, packaging_raw_material_id, qty) VALUES (?, ?, ?)',
          args: [id, r.packaging_raw_material_id, r.qty],
        });
      }
      await tx.execute({ sql: 'DELETE FROM product_barcode_requirements WHERE product_id = ?', args: [id] });
      for (const r of barcodeRequirements) {
        await tx.execute({
          sql: 'INSERT INTO product_barcode_requirements (product_id, packaging_raw_material_id, qty) VALUES (?, ?, ?)',
          args: [id, r.packaging_raw_material_id, r.qty],
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

// Note: deleting a product cascade-deletes its product_requirements,
// product_packaging_requirements, product_barcode_requirements and product_vendor_codes.
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

// Parse a packaging/barcode requirements cell like
// "Corrugated Box|5 Ply:2; EAN Barcode:1" into [{ item_name, variant, qty }].
// Splits entries on ';'; within an entry, the LAST ':' separates qty (same
// rule as parseRequirementsCell), and the FIRST '|' before that separates an
// optional variant (omitted entirely for no-variant items). '|' is this
// codebase's existing convention for category/item/variant lookup keys
// (packagingRawMaterials.controller.js, OutboundVendorsPage.jsx) and is very
// unlikely to collide with a real item name.
function parseArticleRequirementsCell(cell) {
  const out = [];
  const errors = [];
  const items = String(cell || '').split(';').map(s => s.trim()).filter(Boolean);
  for (const item of items) {
    const colonIdx = item.lastIndexOf(':');
    if (colonIdx === -1) { errors.push(`"${item}" is missing ":qty"`); continue; }
    const namePart = item.slice(0, colonIdx).trim();
    const qty = Number(item.slice(colonIdx + 1).trim());
    if (!Number.isInteger(qty) || qty <= 0) { errors.push(`"${item}" has an invalid qty`); continue; }
    const pipeIdx = namePart.indexOf('|');
    const item_name = (pipeIdx === -1 ? namePart : namePart.slice(0, pipeIdx)).trim();
    const variant = pipeIdx === -1 ? '' : namePart.slice(pipeIdx + 1).trim();
    if (!item_name) { errors.push(`"${item}" has no item name`); continue; }
    out.push({ item_name, variant, qty });
  }
  return { out, errors };
}

// item_name+variant (case-insensitive) -> packaging_raw_materials.id, scoped
// to one category. Used to resolve bulk-upload cells for the Packaging and
// Barcode columns without letting either reference the other's articles.
async function loadPackagingArticlesByCategory(category) {
  const { rows } = await db.execute({
    sql: 'SELECT id, item_name, variant FROM packaging_raw_materials WHERE category = ? COLLATE NOCASE',
    args: [category],
  });
  const map = new Map();
  for (const r of rows) {
    const key = `${String(r.item_name).trim().toLowerCase()}|${String(r.variant || '').trim().toLowerCase()}`;
    map.set(key, r.id);
  }
  return map;
}

// Resolve parsed { item_name, variant, qty } entries against a
// key -> packaging_raw_material_id map. Returns { requirements, unknown }
// where `unknown` (a display string) is set on the first unresolved/duplicate
// entry, matching the raw-product bulk-resolve loop's short-circuit style.
function resolveArticleRequirements(parsed, articlesByKey) {
  const requirements = [];
  const seen = new Set();
  for (const p of parsed) {
    const key = `${p.item_name.toLowerCase()}|${p.variant.toLowerCase()}`;
    const id = articlesByKey.get(key);
    const display = `${p.item_name}${p.variant ? ` (${p.variant})` : ''}`;
    if (!id) return { requirements, unknown: display };
    if (seen.has(id)) return { requirements, unknown: `${display} (duplicated)` };
    seen.add(id);
    requirements.push({ packaging_raw_material_id: id, qty: p.qty });
  }
  return { requirements, unknown: null };
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

    const [{ rows: rawRows }, { rows: existing }, packagingByKey, barcodeByKey] = await Promise.all([
      db.execute('SELECT id, name FROM raw_products'),
      db.execute('SELECT sku_code FROM products'),
      loadPackagingArticlesByCategory('Packaging'),
      loadPackagingArticlesByCategory('Barcode'),
    ]);
    const rawByName = new Map(rawRows.map(r => [String(r.name).trim().toLowerCase(), r.id]));
    const existingCodes = new Set(existing.map(e => String(e.sku_code).trim().toLowerCase()));

    const skipped = [];
    let inserted = 0;
    let updated = 0;

    for (let i = 0; i < input.length; i++) {
      const r = input[i] || {};
      const sku_code = normText(r.sku_code);
      if (!sku_code) { skipped.push({ row: i + 2, reason: 'Missing sku_code' }); continue; }

      const { out: parsedRaw, errors: rawErrors } = parseRequirementsCell(r.requirements);
      if (rawErrors.length) { skipped.push({ row: i + 2, reason: rawErrors.join('; ') }); continue; }
      if (!parsedRaw.length) { skipped.push({ row: i + 2, reason: 'No requirements provided' }); continue; }

      const { out: parsedPkg, errors: pkgErrors } = parseArticleRequirementsCell(r.packaging_requirements);
      if (pkgErrors.length) { skipped.push({ row: i + 2, reason: pkgErrors.join('; ') }); continue; }
      if (!parsedPkg.length) { skipped.push({ row: i + 2, reason: 'No packaging requirements provided' }); continue; }

      const { out: parsedBc, errors: bcErrors } = parseArticleRequirementsCell(r.barcode_requirements);
      if (bcErrors.length) { skipped.push({ row: i + 2, reason: bcErrors.join('; ') }); continue; }
      if (!parsedBc.length) { skipped.push({ row: i + 2, reason: 'No barcode requirements provided' }); continue; }

      const requirements = [];
      let unknown = null;
      const seen = new Set();
      for (const p of parsedRaw) {
        const rawId = rawByName.get(p.name.toLowerCase());
        if (!rawId) { unknown = p.name; break; }
        if (seen.has(rawId)) { unknown = `${p.name} (duplicated)`; break; }
        seen.add(rawId);
        requirements.push({ raw_product_id: rawId, qty: p.qty });
      }
      if (unknown) { skipped.push({ row: i + 2, reason: `Unknown raw product "${unknown}"` }); continue; }

      const { requirements: packagingRequirements, unknown: unknownPkg } = resolveArticleRequirements(parsedPkg, packagingByKey);
      if (unknownPkg) { skipped.push({ row: i + 2, reason: `Unknown packaging product "${unknownPkg}"` }); continue; }

      const { requirements: barcodeRequirements, unknown: unknownBc } = resolveArticleRequirements(parsedBc, barcodeByKey);
      if (unknownBc) { skipped.push({ row: i + 2, reason: `Unknown barcode "${unknownBc}"` }); continue; }

      const isUpdate = existingCodes.has(sku_code.toLowerCase());
      const tx = await db.transaction('write');
      try {
        const { rows: up } = await tx.execute({
          sql: `INSERT INTO products (sku_code, description, category, updated_by, updated_at)
                VALUES (?, ?, ?, ?, datetime('now'))
                ON CONFLICT(sku_code) DO UPDATE SET
                  description = excluded.description,
                  category = excluded.category,
                  updated_by = excluded.updated_by,
                  updated_at = excluded.updated_at
                RETURNING id`,
          args: [sku_code, normText(r.description), normText(r.category), req.user.id],
        });
        const productId = up[0].id;
        await tx.execute({ sql: 'DELETE FROM product_requirements WHERE product_id = ?', args: [productId] });
        for (const req2 of requirements) {
          await tx.execute({
            sql: 'INSERT INTO product_requirements (product_id, raw_product_id, qty) VALUES (?, ?, ?)',
            args: [productId, req2.raw_product_id, req2.qty],
          });
        }
        await tx.execute({ sql: 'DELETE FROM product_packaging_requirements WHERE product_id = ?', args: [productId] });
        for (const req2 of packagingRequirements) {
          await tx.execute({
            sql: 'INSERT INTO product_packaging_requirements (product_id, packaging_raw_material_id, qty) VALUES (?, ?, ?)',
            args: [productId, req2.packaging_raw_material_id, req2.qty],
          });
        }
        await tx.execute({ sql: 'DELETE FROM product_barcode_requirements WHERE product_id = ?', args: [productId] });
        for (const req2 of barcodeRequirements) {
          await tx.execute({
            sql: 'INSERT INTO product_barcode_requirements (product_id, packaging_raw_material_id, qty) VALUES (?, ?, ?)',
            args: [productId, req2.packaging_raw_material_id, req2.qty],
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
