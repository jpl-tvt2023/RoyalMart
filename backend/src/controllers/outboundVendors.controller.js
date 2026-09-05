const db = require('../config/db');
const { logAction, diffFields } = require('../services/auditLog.service');
const { pairKey, unitMetricsByPair } = require('../services/outboundProducts.service');

function normName(v) {
  return v == null ? '' : String(v).trim();
}

function normalizeArticles(articles) {
  return articles.map(a => ({
    category: normName(a.category),
    item_name: normName(a.item_name),
    variant: normName(a.variant) || null,
  }));
}

// The full (category, item_name, variant) triple must match an existing
// packaging_raw_materials entry — that master catalog is maintained on the
// Packaging Products page. Variant became part of the catalog's identity in
// migration 056, so it is validated alongside the other two rather than being
// free text as it was before.
async function loadAllowedArticles() {
  const { rows } = await db.execute('SELECT category, item_name, variant, unit_metric FROM packaging_raw_materials');
  return rows;
}

const catalogKey = (c, i, v) => `${normName(c)}|${normName(i)}|${normName(v)}`;

function validateArticles(articles, allowed) {
  if (!articles.length) return 'At least one article mapping is required';
  const allowedSet = new Set(allowed.map(a => catalogKey(a.category, a.item_name, a.variant)));
  for (const a of articles) {
    if (!a.category) return 'Category is required for every mapping';
    if (!a.item_name) return 'Item name is required for every mapping';
    if (!allowedSet.has(catalogKey(a.category, a.item_name, a.variant))) {
      const label = `${a.category} / ${a.item_name}${a.variant ? ` / ${a.variant}` : ''}`;
      return `"${label}" is not a recognized packaging raw material — add it on the Packaging Products page first`;
    }
  }
  return null;
}

// An article's unit_metric is only the DEFAULT a PO line starts from -- since
// migration 064 its (category, item_name) pair can be listed in the Outbound
// Product List under several metrics, and the PO line picks between them. So the
// mapping carries the whole option list alongside the default.
//
// The default is kept in the list even when the master no longer offers it, so a
// line already ordered in a since-retired metric still renders its own value.
function withUnitMetrics(article, metricsByPair) {
  const listed = metricsByPair.get(pairKey(article.category, article.item_name)) || [];
  const unit_metrics = [...listed];
  const fallback = normName(article.unit_metric);
  if (fallback && !unit_metrics.some(m => normName(m).toLowerCase() === fallback.toLowerCase())) {
    unit_metrics.push(article.unit_metric);
  }
  return { ...article, unit_metrics };
}

async function list(req, res, next) {
  try {
    const { rows: vendors } = await db.execute(
      `SELECT v.id, v.name, v.is_active, v.created_at, v.updated_at,
              u.name AS updated_by_name
       FROM outbound_vendors v
       LEFT JOIN users u ON u.id = v.updated_by
       ORDER BY v.is_active DESC, v.name ASC`
    );
    // unit_metric comes from the catalog: it is the UM a new PO line DEFAULTS
    // to. LEFT JOIN so a mapping whose catalog row was since deleted still lists
    // (with a null UM) instead of vanishing.
    const [{ rows: articles }, metricsByPair] = await Promise.all([
      db.execute(
        `SELECT a.id, a.vendor_id, a.category, a.item_name, a.variant, prm.unit_metric
         FROM outbound_vendor_articles a
         LEFT JOIN packaging_raw_materials prm
           ON prm.category = a.category AND prm.item_name = a.item_name
          AND prm.variant = COALESCE(a.variant, '')
         ORDER BY a.id ASC`
      ),
      unitMetricsByPair(),
    ]);
    const byVendor = new Map();
    for (const a of articles) {
      if (!byVendor.has(a.vendor_id)) byVendor.set(a.vendor_id, []);
      byVendor.get(a.vendor_id).push(withUnitMetrics(a, metricsByPair));
    }
    res.json(vendors.map(v => ({ ...v, articles: byVendor.get(v.id) || [] })));
  } catch (err) { next(err); }
}

async function create(req, res, next) {
  try {
    const name = normName(req.body?.name);
    if (!name) return res.status(400).json({ message: 'name is required' });
    const articles = normalizeArticles(req.body?.articles || []);
    const allowed = await loadAllowedArticles();
    const articlesError = validateArticles(articles, allowed);
    if (articlesError) return res.status(400).json({ message: articlesError });

    const tx = await db.transaction('write');
    try {
      const { rows } = await tx.execute({
        sql: 'INSERT INTO outbound_vendors (name) VALUES (?) RETURNING id, name, is_active, created_at',
        args: [name],
      });
      const vendorId = rows[0].id;
      for (const a of articles) {
        await tx.execute({
          sql: `INSERT INTO outbound_vendor_articles (vendor_id, category, item_name, variant)
                VALUES (?, ?, ?, ?)`,
          args: [vendorId, a.category, a.item_name, a.variant],
        });
      }
      await logAction({
        client: tx,
        userId: req.user.id,
        actionType: 'OUTBOUND_VENDOR_CREATE',
        description: `Added outbound vendor "${name}" (${articles.length} mapping${articles.length === 1 ? '' : 's'})`,
        entityType: 'outbound_vendor',
        entityId: vendorId,
      });
      await tx.commit();
      res.status(201).json({ ...rows[0], articles });
    } catch (e) {
      await tx.rollback();
      throw e;
    }
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ message: 'A vendor with that name already exists' });
    }
    next(err);
  }
}

async function update(req, res, next) {
  try {
    const { id } = req.params;
    const has = (k) => Object.prototype.hasOwnProperty.call(req.body || {}, k);
    const { rows: existing } = await db.execute({
      sql: 'SELECT id, name, is_active FROM outbound_vendors WHERE id = ?',
      args: [id],
    });
    if (!existing.length) return res.status(404).json({ message: 'Vendor not found' });
    const current = existing[0];

    let nextName = current.name;
    if (has('name')) {
      const n = normName(req.body.name);
      if (!n) return res.status(400).json({ message: 'name cannot be empty' });
      nextName = n;
    }
    let nextActive = current.is_active;
    if (has('is_active')) nextActive = req.body.is_active ? 1 : 0;

    let nextArticles = null;
    if (has('articles')) {
      nextArticles = normalizeArticles(req.body.articles || []);
      const allowed = await loadAllowedArticles();
      const articlesError = validateArticles(nextArticles, allowed);
      if (articlesError) return res.status(400).json({ message: articlesError });
    }

    const changes = diffFields(current, { name: nextName, is_active: nextActive }, ['name', 'is_active']);

    const tx = await db.transaction('write');
    try {
      const { rows } = await tx.execute({
        sql: `UPDATE outbound_vendors SET name = ?, is_active = ?, updated_by = ?, updated_at = datetime('now')
              WHERE id = ? RETURNING id, name, is_active, created_at, updated_at`,
        args: [nextName, nextActive, req.user.id, id],
      });

      if (nextArticles) {
        await tx.execute({ sql: 'DELETE FROM outbound_vendor_articles WHERE vendor_id = ?', args: [id] });
        for (const a of nextArticles) {
          await tx.execute({
            sql: `INSERT INTO outbound_vendor_articles (vendor_id, category, item_name, variant)
                  VALUES (?, ?, ?, ?)`,
            args: [id, a.category, a.item_name, a.variant],
          });
        }
      }

      await logAction({
        client: tx,
        userId: req.user.id,
        actionType: 'OUTBOUND_VENDOR_UPDATE',
        description: `Updated outbound vendor #${id}: name="${nextName}", active=${nextActive}${nextArticles ? `, ${nextArticles.length} mapping(s)` : ''}`,
        entityType: 'outbound_vendor',
        entityId: id,
        changes,
      });
      await tx.commit();

      const [{ rows: articleRows }, metricsByPair] = await Promise.all([
        db.execute({
          sql: `SELECT a.id, a.category, a.item_name, a.variant, prm.unit_metric
                FROM outbound_vendor_articles a
                LEFT JOIN packaging_raw_materials prm
                  ON prm.category = a.category AND prm.item_name = a.item_name
                 AND prm.variant = COALESCE(a.variant, '')
                WHERE a.vendor_id = ? ORDER BY a.id ASC`,
          args: [id],
        }),
        unitMetricsByPair(),
      ]);
      res.json({ ...rows[0], articles: articleRows.map(a => withUnitMetrics(a, metricsByPair)) });
    } catch (e) {
      await tx.rollback();
      throw e;
    }
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ message: 'A vendor with that name already exists' });
    }
    next(err);
  }
}

async function remove(req, res, next) {
  try {
    const { id } = req.params;
    const { rows: existing } = await db.execute({
      sql: 'SELECT id, name FROM outbound_vendors WHERE id = ?',
      args: [id],
    });
    if (!existing.length) return res.status(404).json({ message: 'Vendor not found' });
    const { rows } = await db.execute({
      sql: 'UPDATE outbound_vendors SET is_active = 0 WHERE id = ? RETURNING id, name, is_active, created_at',
      args: [id],
    });
    await logAction({
      userId: req.user.id,
      actionType: 'OUTBOUND_VENDOR_DEACTIVATE',
      description: `Deactivated outbound vendor "${existing[0].name}"`,
      entityType: 'outbound_vendor',
      entityId: id,
    });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

const BULK_LIMIT = 2000;

async function bulkUpsert(req, res, next) {
  try {
    const { rows: input } = req.body || {};
    if (!Array.isArray(input) || input.length === 0) {
      return res.status(400).json({ message: 'rows must be a non-empty array' });
    }
    if (input.length > BULK_LIMIT) {
      return res.status(400).json({ message: `Too many rows; max ${BULK_LIMIT}` });
    }

    const { rows: vendors } = await db.execute('SELECT id, name FROM outbound_vendors');
    const vendorIdByName = new Map(vendors.map(v => [String(v.name).trim().toLowerCase(), v.id]));

    const { rows: articles } = await db.execute(
      'SELECT vendor_id, category, item_name, variant FROM outbound_vendor_articles'
    );
    const articleKey = (vendorId, a) =>
      `${vendorId}${a.category.toLowerCase()}${a.item_name.toLowerCase()}${(a.variant || '').toLowerCase()}`;
    const existingKeys = new Set(articles.map(a => articleKey(a.vendor_id, a)));

    // Case-insensitive lookup against the current packaging_raw_materials
    // catalog, so hand-edited spreadsheets ("packaging", "CAPS") still map to
    // the official casing stored there.
    const allowed = await loadAllowedArticles();
    const categoryByLower = new Map();
    const itemNamesByCategory = new Map(); // canonical category -> Map(lower item_name -> canonical item_name)
    const variantsByCatItem = new Map();   // "cat|item" -> Map(lower variant -> canonical variant)
    for (const a of allowed) {
      const catLower = a.category.toLowerCase();
      if (!categoryByLower.has(catLower)) categoryByLower.set(catLower, a.category);
      const canonicalCat = categoryByLower.get(catLower);
      if (!itemNamesByCategory.has(canonicalCat)) itemNamesByCategory.set(canonicalCat, new Map());
      itemNamesByCategory.get(canonicalCat).set(a.item_name.toLowerCase(), a.item_name);
      // Variant is part of the catalog identity as of migration 056, so it gets
      // the same case-insensitive canonicalization as category/item_name.
      const vKey = `${canonicalCat}|${a.item_name}`;
      if (!variantsByCatItem.has(vKey)) variantsByCatItem.set(vKey, new Map());
      variantsByCatItem.get(vKey).set(normName(a.variant).toLowerCase(), normName(a.variant));
    }

    const skipped = [];
    let inserted = 0; // mappings added under newly created vendors
    let updated = 0;  // mappings added to pre-existing vendors
    const touchedVendorIds = new Set();
    const mappingsAddedByVendor = new Map(); // vendor_id -> mappings added to it this call

    for (let i = 0; i < input.length; i++) {
      const r = input[i] || {};
      const vendorName = normName(r.vendor_name);
      const category = categoryByLower.get(normName(r.category).toLowerCase());

      if (!vendorName) {
        skipped.push({ row: i + 2, reason: 'vendor_name is required' });
        continue;
      }
      if (!category) {
        skipped.push({ row: i + 2, reason: `Invalid category "${normName(r.category)}" — add it on the Packaging Products page first` });
        continue;
      }
      const itemNameMap = itemNamesByCategory.get(category);
      const itemName = itemNameMap && itemNameMap.get(normName(r.item_name).toLowerCase());
      if (!itemName) {
        skipped.push({ row: i + 2, reason: `Invalid item_name "${normName(r.item_name)}" for ${category} — add it on the Packaging Products page first` });
        continue;
      }
      const variantMap = variantsByCatItem.get(`${category}|${itemName}`);
      const canonicalVariant = variantMap && variantMap.get(normName(r.variant).toLowerCase());
      if (canonicalVariant === undefined) {
        skipped.push({ row: i + 2, reason: `Invalid variant "${normName(r.variant)}" for ${category} / ${itemName} — add it on the Packaging Products page first` });
        continue;
      }
      const variant = canonicalVariant || null;

      try {
        let vendorId = vendorIdByName.get(vendorName.toLowerCase());
        const isNewVendor = vendorId == null;
        if (isNewVendor) {
          const { rows: created } = await db.execute({
            sql: 'INSERT INTO outbound_vendors (name, updated_by) VALUES (?, ?) RETURNING id',
            args: [vendorName, req.user.id],
          });
          vendorId = created[0].id;
          vendorIdByName.set(vendorName.toLowerCase(), vendorId);
        }

        const key = articleKey(vendorId, { category, item_name: itemName, variant });
        if (existingKeys.has(key)) {
          skipped.push({ row: i + 2, reason: `Mapping already exists for "${vendorName}"` });
          continue;
        }
        await db.execute({
          sql: `INSERT INTO outbound_vendor_articles (vendor_id, category, item_name, variant)
                VALUES (?, ?, ?, ?)`,
          args: [vendorId, category, itemName, variant],
        });
        existingKeys.add(key);
        touchedVendorIds.add(vendorId);
        mappingsAddedByVendor.set(vendorId, (mappingsAddedByVendor.get(vendorId) || 0) + 1);
        if (isNewVendor) inserted++;
        else updated++;
      } catch (e) {
        skipped.push({ row: i + 2, reason: e.message || 'DB error' });
      }
    }

    // Bulk upsert touches many vendors in one call, so besides the aggregate
    // entry below (entityId: null, for a future global-activity view), log one
    // per-vendor entry too — otherwise a vendor's own History drawer could
    // never show that it was updated by a bulk upload.
    for (const vendorId of touchedVendorIds) {
      await db.execute({
        sql: "UPDATE outbound_vendors SET updated_by = ?, updated_at = datetime('now') WHERE id = ?",
        args: [req.user.id, vendorId],
      });
      const count = mappingsAddedByVendor.get(vendorId) || 0;
      await logAction({
        userId: req.user.id,
        actionType: 'OUTBOUND_VENDOR_BULK_UPSERT',
        description: `Bulk upload added ${count} article mapping${count === 1 ? '' : 's'} to this vendor`,
        entityType: 'outbound_vendor',
        entityId: vendorId,
      });
    }

    await logAction({
      userId: req.user.id,
      actionType: 'OUTBOUND_VENDOR_BULK_UPSERT',
      description: `Bulk: +${inserted} inserted, ~${updated} updated, !${skipped.length} skipped`,
      entityType: 'outbound_vendor',
      entityId: null,
    });

    res.json({ inserted, updated, skipped });
  } catch (err) { next(err); }
}

module.exports = { list, create, update, remove, bulkUpsert };
