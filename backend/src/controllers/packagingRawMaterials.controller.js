const db = require('../config/db');
const { logAction, diffFields } = require('../services/auditLog.service');

const PACKAGING_RAW_MATERIAL_FIELDS = ['category', 'item_name', 'variant', 'unit_metric'];
const BULK_LIMIT = 2000;

function normText(v) {
  return v == null ? '' : String(v).trim();
}

// '' is the canonical "no variant" in the DB (a nullable variant would break
// UNIQUE dedupe, since SQLite treats NULLs as distinct). Callers outside this
// module see null instead, which is what the rest of the API uses.
const variantKey = (v) => normText(v).toLowerCase();
const tripleKey = (c, i, v) => `${normText(c).toLowerCase()}|${normText(i).toLowerCase()}|${variantKey(v)}`;
const pairKey = (c, i) => `${normText(c).toLowerCase()}|${normText(i).toLowerCase()}`;
const outward = (row) => ({ ...row, variant: row.variant || null });

// (Category, Item Name) must exist and be active in the Outbound Product List,
// which is maintained under Configurations. Same shape as loadAllowedArticles /
// validateArticles in outboundVendors.controller.js, one level up: that file
// validates vendor mappings against this catalog, this one validates the
// catalog against the taxonomy above it.
async function loadOutboundProducts() {
  const { rows } = await db.execute(
    'SELECT category, item_name, unit_metric FROM outbound_products WHERE is_active = 1'
  );
  return new Map(rows.map(r => [pairKey(r.category, r.item_name), r]));
}

const unlistedMessage = (category, itemName) =>
  `"${category} / ${itemName}" is not in the Outbound Product List — add it under Configurations → Outbound Product List first`;

async function list(req, res, next) {
  try {
    // Two queries plus a JS join rather than GROUP_CONCAT: SQLite forbids a
    // custom separator with DISTINCT, and vendor names can contain commas.
    const [{ rows }, { rows: mappings }] = await Promise.all([
      db.execute(`
        SELECT prm.*, u.name AS updated_by_name
        FROM packaging_raw_materials prm
        LEFT JOIN users u ON u.id = prm.updated_by
        ORDER BY prm.category COLLATE NOCASE, prm.item_name COLLATE NOCASE, prm.variant COLLATE NOCASE
      `),
      db.execute(`
        SELECT DISTINCT a.category, a.item_name, COALESCE(a.variant, '') AS variant, v.name
        FROM outbound_vendor_articles a
        JOIN outbound_vendors v ON v.id = a.vendor_id
        ORDER BY v.name COLLATE NOCASE
      `),
    ]);

    const vendorsByTriple = new Map();
    for (const m of mappings) {
      const k = tripleKey(m.category, m.item_name, m.variant);
      if (!vendorsByTriple.has(k)) vendorsByTriple.set(k, []);
      vendorsByTriple.get(k).push(m.name);
    }

    res.json(rows.map(r => {
      const names = vendorsByTriple.get(tripleKey(r.category, r.item_name, r.variant)) || [];
      return { ...outward(r), vendor_names: names, vendor_count: names.length };
    }));
  } catch (err) { next(err); }
}

async function create(req, res, next) {
  try {
    const inputCategory = normText(req.body.category);
    const inputItemName = normText(req.body.item_name);
    const variant = normText(req.body.variant);
    if (!inputCategory) return res.status(400).json({ message: 'category is required' });
    if (!inputItemName) return res.status(400).json({ message: 'item_name is required' });

    // Category, item name and unit metric all come from the Outbound Product
    // List: the stored values are canonicalised to the master's casing, and the
    // unit metric is taken from it rather than from the request, so the master
    // stays the single source of truth for it.
    const master = await loadOutboundProducts();
    const listed = master.get(pairKey(inputCategory, inputItemName));
    if (!listed) return res.status(400).json({ message: unlistedMessage(inputCategory, inputItemName) });
    const category = listed.category;
    const itemName = listed.item_name;
    const unitMetric = listed.unit_metric;

    const { rows } = await db.execute({
      sql: `INSERT INTO packaging_raw_materials (category, item_name, variant, unit_metric, updated_by, updated_at)
            VALUES (?, ?, ?, ?, ?, datetime('now')) RETURNING *`,
      args: [category, itemName, variant, unitMetric, req.user.id],
    });
    await logAction({
      userId: req.user.id,
      actionType: 'PACKAGING_RAW_MATERIAL_CREATE',
      description: `Created packaging product ${category} / ${itemName}${variant ? ` / ${variant}` : ''}`,
      entityType: 'packaging_raw_material',
      entityId: rows[0].id,
    });
    res.status(201).json(outward(rows[0]));
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ message: 'This category + item name + variant combination already exists' });
    }
    next(err);
  }
}

async function update(req, res, next) {
  try {
    const { id } = req.params;
    const { rows: existing } = await db.execute({ sql: 'SELECT * FROM packaging_raw_materials WHERE id = ?', args: [id] });
    if (!existing.length) return res.status(404).json({ message: 'Packaging product not found' });

    const inputCategory = normText(req.body.category ?? existing[0].category);
    const inputItemName = normText(req.body.item_name ?? existing[0].item_name);
    const variant = normText(req.body.variant ?? existing[0].variant);
    if (!inputCategory) return res.status(400).json({ message: 'category is required' });
    if (!inputItemName) return res.status(400).json({ message: 'item_name is required' });

    const master = await loadOutboundProducts();
    const listed = master.get(pairKey(inputCategory, inputItemName));
    if (!listed) return res.status(400).json({ message: unlistedMessage(inputCategory, inputItemName) });
    const category = listed.category;
    const itemName = listed.item_name;
    const unitMetric = listed.unit_metric;

    const { rows } = await db.execute({
      sql: `UPDATE packaging_raw_materials
            SET category = ?, item_name = ?, variant = ?, unit_metric = ?, updated_by = ?, updated_at = datetime('now')
            WHERE id = ? RETURNING *`,
      args: [category, itemName, variant, unitMetric, req.user.id, id],
    });
    const changes = diffFields(existing[0], rows[0], PACKAGING_RAW_MATERIAL_FIELDS);
    await logAction({
      userId: req.user.id,
      actionType: 'PACKAGING_RAW_MATERIAL_UPDATE',
      description: `Updated packaging product ${category} / ${itemName}${variant ? ` / ${variant}` : ''}`,
      entityType: 'packaging_raw_material',
      entityId: id,
      changes,
    });
    res.json(outward(rows[0]));
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ message: 'This category + item name + variant combination already exists' });
    }
    next(err);
  }
}

async function remove(req, res, next) {
  try {
    const { id } = req.params;
    const { rows } = await db.execute({ sql: 'DELETE FROM packaging_raw_materials WHERE id = ? RETURNING category, item_name, variant', args: [id] });
    if (!rows.length) return res.status(404).json({ message: 'Packaging product not found' });
    await logAction({
      userId: req.user.id,
      actionType: 'PACKAGING_RAW_MATERIAL_DELETE',
      description: `Deleted packaging product ${rows[0].category} / ${rows[0].item_name}${rows[0].variant ? ` / ${rows[0].variant}` : ''}`,
      entityType: 'packaging_raw_material',
      entityId: id,
    });
    res.json({ deleted: true });
  } catch (err) { next(err); }
}

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
        sql: `DELETE FROM packaging_raw_materials WHERE id IN (${placeholders}) RETURNING id`,
        args: cleanIds,
      });
      await logAction({
        client: tx,
        userId: req.user.id,
        actionType: 'PACKAGING_RAW_MATERIAL_BULK_DELETE',
        description: `Deleted ${rows.length} packaging raw material${rows.length !== 1 ? 's' : ''}`,
        entityType: 'packaging_raw_material',
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

async function bulkUpsert(req, res, next) {
  try {
    const { rows: input } = req.body || {};
    if (!Array.isArray(input) || input.length === 0) {
      return res.status(400).json({ message: 'rows must be a non-empty array' });
    }
    if (input.length > BULK_LIMIT) {
      return res.status(400).json({ message: `Too many rows; max ${BULK_LIMIT}` });
    }

    const [{ rows: existing }, master] = await Promise.all([
      db.execute('SELECT category, item_name, variant FROM packaging_raw_materials'),
      loadOutboundProducts(),
    ]);
    const existingKeys = new Set(existing.map(e => tripleKey(e.category, e.item_name, e.variant)));

    const skipped = [];
    let inserted = 0;
    let updated = 0;

    for (let i = 0; i < input.length; i++) {
      const r = input[i] || {};
      const inputCategory = normText(r.category);
      const inputItemName = normText(r.item_name);
      const variant = normText(r.variant);
      if (!inputCategory) { skipped.push({ row: i + 2, reason: 'Missing category' }); continue; }
      if (!inputItemName) { skipped.push({ row: i + 2, reason: 'Missing item_name' }); continue; }

      // A unit_metric column in the sheet is ignored -- it comes from the
      // Outbound Product List, as does the canonical casing of the pair.
      const listed = master.get(pairKey(inputCategory, inputItemName));
      if (!listed) { skipped.push({ row: i + 2, reason: unlistedMessage(inputCategory, inputItemName) }); continue; }
      const category = listed.category;
      const itemName = listed.item_name;
      const unitMetric = listed.unit_metric;

      const key = tripleKey(category, itemName, variant);
      const isUpdate = existingKeys.has(key);
      try {
        await db.execute({
          sql: `INSERT INTO packaging_raw_materials (category, item_name, variant, unit_metric, updated_by, updated_at)
                VALUES (?, ?, ?, ?, ?, datetime('now'))
                ON CONFLICT(category, item_name, variant) DO UPDATE SET
                  unit_metric = excluded.unit_metric,
                  updated_by = excluded.updated_by,
                  updated_at = excluded.updated_at`,
          args: [category, itemName, variant, unitMetric, req.user.id],
        });
        if (isUpdate) updated++;
        else { inserted++; existingKeys.add(key); }
      } catch (e) {
        skipped.push({ row: i + 2, reason: e.message || 'DB error' });
      }
    }

    await logAction({
      userId: req.user.id,
      actionType: 'PACKAGING_RAW_MATERIAL_BULK_UPSERT',
      description: `Bulk: +${inserted} inserted, ~${updated} updated, !${skipped.length} skipped`,
      entityType: 'packaging_raw_material',
      entityId: null,
    });

    res.json({ inserted, updated, skipped });
  } catch (err) { next(err); }
}

module.exports = { list, create, update, remove, bulkDelete, bulkUpsert };
