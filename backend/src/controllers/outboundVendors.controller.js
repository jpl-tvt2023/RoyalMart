const db = require('../config/db');
const { logAction, diffFields } = require('../services/auditLog.service');
const { CATEGORIES, ITEM_NAME_OPTIONS } = require('../constants/outboundArticles');

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

// Category must be one of the fixed set; Item Name must be one of that
// category's fixed choices, except 'Others' which accepts any free text.
function validateArticles(articles) {
  if (!articles.length) return 'At least one article mapping is required';
  for (const a of articles) {
    if (!CATEGORIES.includes(a.category)) return `Invalid category "${a.category}"`;
    if (!a.item_name) return 'Item name is required for every mapping';
    const fixedList = ITEM_NAME_OPTIONS[a.category];
    if (fixedList && !fixedList.includes(a.item_name)) {
      return `"${a.item_name}" is not a valid item name for ${a.category}`;
    }
  }
  return null;
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
    const { rows: articles } = await db.execute(
      'SELECT id, vendor_id, category, item_name, variant FROM outbound_vendor_articles ORDER BY id ASC'
    );
    const byVendor = new Map();
    for (const a of articles) {
      if (!byVendor.has(a.vendor_id)) byVendor.set(a.vendor_id, []);
      byVendor.get(a.vendor_id).push(a);
    }
    res.json(vendors.map(v => ({ ...v, articles: byVendor.get(v.id) || [] })));
  } catch (err) { next(err); }
}

async function create(req, res, next) {
  try {
    const name = normName(req.body?.name);
    if (!name) return res.status(400).json({ message: 'name is required' });
    const articles = normalizeArticles(req.body?.articles || []);
    const articlesError = validateArticles(articles);
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
      const articlesError = validateArticles(nextArticles);
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

      const { rows: articleRows } = await db.execute({
        sql: 'SELECT id, category, item_name, variant FROM outbound_vendor_articles WHERE vendor_id = ? ORDER BY id ASC',
        args: [id],
      });
      res.json({ ...rows[0], articles: articleRows });
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

// Case-insensitive lookup of the canonical value from a fixed list, so
// hand-edited spreadsheets ("packaging", "CAPS") still map to the official
// casing stored in the DB.
function canonical(list, value) {
  const v = String(value || '').trim().toLowerCase();
  return list.find(x => x.toLowerCase() === v) || null;
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

    const { rows: vendors } = await db.execute('SELECT id, name FROM outbound_vendors');
    const vendorIdByName = new Map(vendors.map(v => [String(v.name).trim().toLowerCase(), v.id]));

    const { rows: articles } = await db.execute(
      'SELECT vendor_id, category, item_name, variant FROM outbound_vendor_articles'
    );
    const articleKey = (vendorId, a) =>
      `${vendorId}${a.category.toLowerCase()}${a.item_name.toLowerCase()}${(a.variant || '').toLowerCase()}`;
    const existingKeys = new Set(articles.map(a => articleKey(a.vendor_id, a)));

    const skipped = [];
    let inserted = 0; // mappings added under newly created vendors
    let updated = 0;  // mappings added to pre-existing vendors
    const touchedVendorIds = new Set();
    const mappingsAddedByVendor = new Map(); // vendor_id -> mappings added to it this call

    for (let i = 0; i < input.length; i++) {
      const r = input[i] || {};
      const vendorName = normName(r.vendor_name);
      const category = canonical(CATEGORIES, r.category);
      const variant = normName(r.variant) || null;

      if (!vendorName) {
        skipped.push({ row: i + 2, reason: 'vendor_name is required' });
        continue;
      }
      if (!category) {
        skipped.push({ row: i + 2, reason: `Invalid category "${normName(r.category)}" (use ${CATEGORIES.join(', ')})` });
        continue;
      }
      const fixedList = ITEM_NAME_OPTIONS[category];
      const itemName = fixedList ? canonical(fixedList, r.item_name) : normName(r.item_name);
      if (!itemName) {
        skipped.push({
          row: i + 2,
          reason: fixedList
            ? `Invalid item_name "${normName(r.item_name)}" for ${category} (use ${fixedList.join(', ')})`
            : 'item_name is required',
        });
        continue;
      }

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
