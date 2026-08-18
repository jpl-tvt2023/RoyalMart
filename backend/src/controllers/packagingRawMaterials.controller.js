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
//
// Since migration 064 one pair can be listed under several unit metrics, so the
// index is pair -> [rows] rather than pair -> row.
async function loadOutboundProducts() {
  const { rows } = await db.execute(
    `SELECT category, item_name, unit_metric FROM outbound_products
     WHERE is_active = 1
     ORDER BY unit_metric COLLATE NOCASE`
  );
  const map = new Map();
  for (const r of rows) {
    const k = pairKey(r.category, r.item_name);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return map;
}

const unlistedMessage = (category, itemName) =>
  `"${category} / ${itemName}" is not in the Outbound Product List — add it under Configurations → Outbound Product List first`;

const ambiguousMetricMessage = (category, itemName, options) =>
  `"${category} / ${itemName}" is listed under more than one unit metric (${options.map(o => o.unit_metric).join(', ')}) — say which one this product uses`;

// Resolves the Outbound Product entry a submitted row refers to, returning
// either { listed } or { error }.
//
// A pair with exactly one metric ignores the submitted metric entirely: the
// master stays the single source of truth, every existing caller keeps working,
// and a spreadsheet carrying a stale unit_metric column is still accepted. Only
// a genuinely ambiguous pair requires the caller to say which metric it means.
function resolveListed(master, category, itemName, submittedMetric) {
  const options = master.get(pairKey(category, itemName));
  if (!options || !options.length) return { error: unlistedMessage(category, itemName) };
  if (options.length === 1) return { listed: options[0] };

  const metric = normText(submittedMetric).toLowerCase();
  const match = metric && options.find(o => normText(o.unit_metric).toLowerCase() === metric);
  if (!match) return { error: ambiguousMetricMessage(category, itemName, options) };
  return { listed: match };
}

// Deleting or renaming a catalog row out from under a vendor that still maps
// to it leaves that vendor permanently unsaveable (validateArticles in
// outboundVendors.controller.js rejects the whole payload on every future
// save). Same join shape as list()'s vendorsByTriple, reused here as a guard.
async function referencingVendorNames(category, itemName, variant) {
  const { rows } = await db.execute({
    sql: `SELECT DISTINCT v.name FROM outbound_vendor_articles a
          JOIN outbound_vendors v ON v.id = a.vendor_id
          WHERE a.category = ? AND a.item_name = ? AND COALESCE(a.variant, '') = ?`,
    args: [category, itemName, variant || ''],
  });
  return rows.map(r => r.name);
}

const referencedMessage = (category, itemName, variant, names) =>
  `Cannot delete "${category} / ${itemName}${variant ? ` / ${variant}` : ''}" — still mapped to vendor(s): ${names.join(', ')}. Remove those mappings first.`;

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
    // stays the single source of truth for it. The request's unit_metric only
    // ever selects between the master's own options for an ambiguous pair.
    const master = await loadOutboundProducts();
    const { listed, error } = resolveListed(master, inputCategory, inputItemName, req.body.unit_metric);
    if (error) return res.status(400).json({ message: error });
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
    const { listed, error } = resolveListed(
      master, inputCategory, inputItemName, req.body.unit_metric ?? existing[0].unit_metric
    );
    if (error) return res.status(400).json({ message: error });
    const category = listed.category;
    const itemName = listed.item_name;
    const unitMetric = listed.unit_metric;

    // Only a change to the (category, item_name, variant) identity can orphan
    // a vendor mapping -- a plain unit_metric edit is always safe. Rather than
    // blocking the edit, the rename is cascaded onto any vendor mapping still
    // pointing at the old identity, since outbound_vendor_articles matches by
    // this same text triple rather than by id.
    const identityChanged = tripleKey(category, itemName, variant) !==
      tripleKey(existing[0].category, existing[0].item_name, existing[0].variant);

    const tx = await db.transaction('write');
    let rows;
    try {
      ({ rows } = await tx.execute({
        sql: `UPDATE packaging_raw_materials
              SET category = ?, item_name = ?, variant = ?, unit_metric = ?, updated_by = ?, updated_at = datetime('now')
              WHERE id = ? RETURNING *`,
        args: [category, itemName, variant, unitMetric, req.user.id, id],
      }));

      if (identityChanged) {
        await tx.execute({
          sql: `UPDATE outbound_vendor_articles SET category = ?, item_name = ?, variant = ?
                WHERE category = ? AND item_name = ? AND COALESCE(variant, '') = ?`,
          args: [category, itemName, variant, existing[0].category, existing[0].item_name, existing[0].variant || ''],
        });
      }

      const changes = diffFields(existing[0], rows[0], PACKAGING_RAW_MATERIAL_FIELDS);
      await logAction({
        client: tx,
        userId: req.user.id,
        actionType: 'PACKAGING_RAW_MATERIAL_UPDATE',
        description: `Updated packaging product ${category} / ${itemName}${variant ? ` / ${variant}` : ''}`,
        entityType: 'packaging_raw_material',
        entityId: id,
        changes,
      });
      await tx.commit();
    } catch (e) {
      await tx.rollback();
      throw e;
    }
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
    const { rows: existing } = await db.execute({ sql: 'SELECT category, item_name, variant FROM packaging_raw_materials WHERE id = ?', args: [id] });
    if (!existing.length) return res.status(404).json({ message: 'Packaging product not found' });

    const names = await referencingVendorNames(existing[0].category, existing[0].item_name, existing[0].variant);
    if (names.length) {
      return res.status(400).json({ message: referencedMessage(existing[0].category, existing[0].item_name, existing[0].variant, names) });
    }

    const { rows } = await db.execute({ sql: 'DELETE FROM packaging_raw_materials WHERE id = ? RETURNING category, item_name, variant', args: [id] });
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
    const { rows: candidates } = await db.execute({
      sql: `SELECT id, category, item_name, variant FROM packaging_raw_materials WHERE id IN (${placeholders})`,
      args: cleanIds,
    });

    // Rows still mapped to a vendor are skipped rather than failing the whole
    // batch, same convention as bulkUpsert's skipped list below.
    const skipped = [];
    const deletableIds = [];
    for (const row of candidates) {
      const names = await referencingVendorNames(row.category, row.item_name, row.variant);
      if (names.length) skipped.push({ id: row.id, reason: referencedMessage(row.category, row.item_name, row.variant, names) });
      else deletableIds.push(row.id);
    }
    if (!deletableIds.length) return res.json({ deleted: 0, skipped });

    const delPlaceholders = deletableIds.map(() => '?').join(',');
    const tx = await db.transaction('write');
    try {
      const { rows } = await tx.execute({
        sql: `DELETE FROM packaging_raw_materials WHERE id IN (${delPlaceholders}) RETURNING id`,
        args: deletableIds,
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
      res.json({ deleted: rows.length, skipped });
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

      // The sheet's unit_metric column is ignored unless the pair is listed
      // under several metrics, in which case it selects between them -- the
      // value still comes from the Outbound Product List either way, as does
      // the canonical casing of the pair.
      const { listed, error } = resolveListed(master, inputCategory, inputItemName, r.unit_metric);
      if (error) { skipped.push({ row: i + 2, reason: error }); continue; }
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
