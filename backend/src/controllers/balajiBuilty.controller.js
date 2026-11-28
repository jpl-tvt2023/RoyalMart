const db = require('../config/db');
const { logAction, diffFields } = require('../services/auditLog.service');
const { FIELDS, entryFieldsError, normEntry } = require('../services/balajiBuilty.service');
const { buildPagination, buildOrderBy } = require('./marketplacePO.controller');

// Balaji Builty (migration 108): a hand-kept builty sheet. The columns match
// the Builty page, but nothing is read from a marketplace PO -- staff type
// every field, and only Last Updated is the system's. Each entry's id is
// P001, P002 ... minted here. Vendor is free text, and the page's tabs are the
// distinct vendors, compared ignoring case.

const ENTITY = 'balaji_builty';
const ID_PREFIX = 'P';
const pad3 = (n) => String(n).padStart(3, '0');

// P1000 must sort after P999, so the id sorts by its number.
const ID_SORT = `CAST(SUBSTR(b.po_id, ${ID_PREFIX.length + 1}) AS INTEGER)`;

const SORT_COLUMNS = {
  po_id:         ID_SORT,
  po_date:       'b.po_date',
  vendor:        'b.vendor COLLATE NOCASE',
  party_name:    'b.party_name COLLATE NOCASE',
  vendor_po_id:  'b.vendor_po_id',
  qty:           'b.qty',
  city:          'b.city COLLATE NOCASE',
  expiry_date:   'b.expiry_date',
  dispatch_date: 'b.dispatch_date',
  courier:       'b.courier COLLATE NOCASE',
  tracking_id:   'b.tracking_id',
  bill_no:       'b.bill_no',
  bill_date:     'b.bill_date',
  updated_at:    'b.updated_at',
};

const SELECT = `
  SELECT b.po_id, b.po_date, b.vendor, b.party_name, b.vendor_po_id, b.qty, b.city,
         b.expiry_date, b.dispatch_date, b.courier, b.tracking_id, b.bill_no, b.bill_date,
         b.created_at, b.updated_at, ub.name AS updated_by_name
    FROM balaji_builty b
    LEFT JOIN users ub ON ub.id = b.updated_by`;

// The filters every tab shares: Order Date range, City, Courier. Vendor is the
// tab, added by the caller.
//
// An entry with NO Order Date matches any date range. Order Date is typed by
// hand and may be left blank, and the page opens on a date range (Builty's two
// months), so an undated entry would otherwise vanish the moment it is saved.
// Courier 'unassigned' means none typed, as on Builty.
function sharedFilters(q) {
  const conditions = ['b.deleted_at IS NULL'];
  const args = [];
  if (q.po_date_from) { conditions.push('(b.po_date IS NULL OR b.po_date >= ?)'); args.push(q.po_date_from); }
  if (q.po_date_to)   { conditions.push('(b.po_date IS NULL OR b.po_date <= ?)'); args.push(q.po_date_to); }
  if (q.city)    { conditions.push('b.city = ? COLLATE NOCASE'); args.push(String(q.city)); }
  if (q.courier === 'unassigned') {
    conditions.push('b.courier IS NULL');
  } else if (q.courier) {
    conditions.push('b.courier = ? COLLATE NOCASE'); args.push(String(q.courier));
  }
  return { conditions, args };
}

async function list(req, res, next) {
  try {
    const { conditions, args } = sharedFilters(req.query);
    const vendor = req.query.vendor;
    if (vendor && vendor !== 'All') { conditions.push('b.vendor = ? COLLATE NOCASE'); args.push(String(vendor)); }
    const where = `WHERE ${conditions.join(' AND ')}`;
    const orderBy = buildOrderBy(req.query, SORT_COLUMNS, `${ID_SORT} DESC`);
    const pag = buildPagination(req.query);

    const { rows: countRows } = await db.execute({ sql: `SELECT COUNT(*) AS n FROM balaji_builty b ${where}`, args });
    const total = Number(countRows[0].n) || 0;
    const limit = pag.paginated ? ' LIMIT ? OFFSET ?' : '';
    const { rows } = await db.execute({
      sql: `${SELECT} ${where} ORDER BY ${orderBy}, ${ID_SORT} DESC${limit}`,
      args: pag.paginated ? [...args, pag.page_size, pag.offset] : args,
    });
    res.json({
      rows,
      total,
      page: pag.paginated ? pag.page : 1,
      page_size: pag.paginated ? pag.page_size : total,
    });
  } catch (err) { next(err); }
}

// The tabs: every vendor among live entries (one tab per vendor, ignoring
// case, named by its most recent spelling), each counted under the shared
// filters -- so a tab stays put, at 0, when the filters leave it empty.
async function tabs(req, res, next) {
  try {
    const { conditions, args } = sharedFilters(req.query);
    const match = conditions.slice(1).join(' AND ') || '1';
    const { rows } = await db.execute({
      sql: `SELECT (SELECT x.vendor FROM balaji_builty x
                     WHERE x.deleted_at IS NULL AND x.vendor = b.vendor COLLATE NOCASE
                     ORDER BY x.updated_at DESC, x.po_id DESC LIMIT 1) AS vendor,
                   SUM(CASE WHEN ${match} THEN 1 ELSE 0 END) AS count
              FROM balaji_builty b
             WHERE b.deleted_at IS NULL
             GROUP BY b.vendor COLLATE NOCASE
             ORDER BY b.vendor COLLATE NOCASE`,
      args,
    });
    const vendors = rows.map((r) => ({ vendor: r.vendor, count: Number(r.count) || 0 }));
    res.json({ all: vendors.reduce((s, v) => s + v.count, 0), vendors });
  } catch (err) { next(err); }
}

// Values already used, for the inputs' suggestions and the filter selects.
async function options(req, res, next) {
  try {
    const distinct = async (col) => {
      const { rows } = await db.execute(
        `SELECT MIN(${col}) AS v FROM balaji_builty
          WHERE deleted_at IS NULL AND ${col} IS NOT NULL AND TRIM(${col}) <> ''
          GROUP BY ${col} COLLATE NOCASE ORDER BY ${col} COLLATE NOCASE`,
      );
      return rows.map((r) => r.v);
    };
    res.json({
      vendors: await distinct('vendor'),
      party_names: await distinct('party_name'),
      cities: await distinct('city'),
      couriers: await distinct('courier'),
    });
  } catch (err) { next(err); }
}

// One more than the highest serial ever used, deleted entries included, so a
// number is never handed out twice.
async function nextId(client) {
  const { rows } = await client.execute({
    sql: `SELECT MAX(CAST(SUBSTR(po_id, ?) AS INTEGER)) AS max_seq
            FROM balaji_builty WHERE po_id GLOB ? || '[0-9]*'`,
    args: [ID_PREFIX.length + 1, ID_PREFIX],
  });
  return `${ID_PREFIX}${pad3((Number(rows[0]?.max_seq) || 0) + 1)}`;
}

// Live entries other than `poId` already holding `billNo`.
async function billNoConflicts(client, billNo, poId) {
  const { rows } = await client.execute({
    sql: `SELECT po_id, vendor, vendor_po_id FROM balaji_builty
           WHERE bill_no = ? AND po_id IS NOT ? AND deleted_at IS NULL`,
    args: [billNo, poId ?? null],
  });
  return rows;
}

const conflictBody = (billNo, conflicts) => ({
  error: 'bill_no_duplicate',
  message: `Bill no ${billNo} is already used on ${conflicts.map((c) => c.po_id).join(', ')}`,
  conflicts,
});

const isUniqueViolation = (err, what) => Boolean(err && err.message && err.message.includes(`UNIQUE constraint failed: balaji_builty.${what}`));

async function getRow(client, poId) {
  const { rows } = await client.execute({ sql: `${SELECT} WHERE b.po_id = ? AND b.deleted_at IS NULL`, args: [poId] });
  return rows[0] || null;
}

async function create(req, res, next) {
  try {
    const values = { ...Object.fromEntries(FIELDS.map((f) => [f, null])), ...normEntry(req.body) };
    const err = entryFieldsError(values);
    if (err) return res.status(400).json({ message: err });

    // Two saves at the same moment can draw the same id: the loser retries.
    for (let attempt = 0; attempt < 3; attempt++) {
      const tx = await db.transaction('write');
      try {
        if (values.bill_no) {
          const conflicts = await billNoConflicts(tx, values.bill_no, null);
          if (conflicts.length) {
            await tx.rollback();
            return res.status(409).json(conflictBody(values.bill_no, conflicts));
          }
        }
        const poId = await nextId(tx);
        await tx.execute({
          sql: `INSERT INTO balaji_builty (po_id, ${FIELDS.join(', ')}, created_by, updated_by)
                VALUES (?, ${FIELDS.map(() => '?').join(', ')}, ?, ?)`,
          args: [poId, ...FIELDS.map((f) => values[f]), req.user.id, req.user.id],
        });
        await logAction({
          client: tx,
          userId: req.user.id,
          actionType: 'BALAJI_BUILTY_CREATE',
          description: `Created Balaji Builty ${poId} (${values.vendor}${values.vendor_po_id ? `, PO No. ${values.vendor_po_id}` : ''})`,
          entityType: ENTITY,
          entityRef: poId,
          changes: diffFields(null, values, FIELDS),
        });
        await tx.commit();
        return res.status(201).json(await getRow(db, poId));
      } catch (e) {
        await tx.rollback().catch(() => {});
        if (isUniqueViolation(e, 'po_id') && attempt < 2) continue;
        if (isUniqueViolation(e, 'bill_no')) {
          const conflicts = await billNoConflicts(db, values.bill_no, null);
          return res.status(409).json(conflictBody(values.bill_no, conflicts));
        }
        throw e;
      }
    }
    return res.status(409).json({ message: 'Could not assign an id -- try again' });
  } catch (err) { next(err); }
}

// PATCH: only the fields sent change. The rules run on the entry as it will
// be saved, so clearing a Bill Date under a Bill no is refused too.
async function update(req, res, next) {
  try {
    const poId = req.params.id;
    const patch = normEntry(req.body);
    const before = await getRow(db, poId);
    if (!before) return res.status(404).json({ message: 'Entry not found' });
    if (Object.keys(patch).length === 0) return res.json(before);

    const after = { ...before, ...patch };
    const err = entryFieldsError(after);
    if (err) return res.status(400).json({ message: err });

    const changes = diffFields(before, patch, FIELDS);
    if (changes.length === 0) return res.json(before);

    if (changes.some((c) => c.field === 'bill_no') && after.bill_no) {
      const conflicts = await billNoConflicts(db, after.bill_no, poId);
      if (conflicts.length) return res.status(409).json(conflictBody(after.bill_no, conflicts));
    }

    const cols = changes.map((c) => c.field);
    const tx = await db.transaction('write');
    try {
      const { rowsAffected } = await tx.execute({
        sql: `UPDATE balaji_builty SET ${cols.map((c) => `${c} = ?`).join(', ')},
                     updated_by = ?, updated_at = datetime('now')
               WHERE po_id = ? AND deleted_at IS NULL`,
        args: [...cols.map((c) => patch[c]), req.user.id, poId],
      });
      if (!rowsAffected) {
        await tx.rollback();
        return res.status(404).json({ message: 'Entry not found' });
      }
      await logAction({
        client: tx,
        userId: req.user.id,
        actionType: 'BALAJI_BUILTY_UPDATE',
        description: `Updated Balaji Builty ${poId}: ${cols.join(', ')}`,
        entityType: ENTITY,
        entityRef: poId,
        changes,
      });
      await tx.commit();
    } catch (e) {
      await tx.rollback().catch(() => {});
      if (isUniqueViolation(e, 'bill_no')) {
        const conflicts = await billNoConflicts(db, after.bill_no, poId);
        return res.status(409).json(conflictBody(after.bill_no, conflicts));
      }
      throw e;
    }
    res.json(await getRow(db, poId));
  } catch (err) { next(err); }
}

async function remove(req, res, next) {
  try {
    const poId = req.params.id;
    const tx = await db.transaction('write');
    try {
      const { rows } = await tx.execute({
        sql: `UPDATE balaji_builty SET deleted_at = datetime('now'), deleted_by = ?
               WHERE po_id = ? AND deleted_at IS NULL
               RETURNING po_id, vendor, vendor_po_id`,
        args: [req.user.id, poId],
      });
      if (!rows.length) {
        await tx.rollback();
        return res.status(404).json({ message: 'Entry not found' });
      }
      await logAction({
        client: tx,
        userId: req.user.id,
        actionType: 'BALAJI_BUILTY_DELETE',
        description: `Deleted Balaji Builty ${poId} (${rows[0].vendor}${rows[0].vendor_po_id ? `, PO No. ${rows[0].vendor_po_id}` : ''})`,
        entityType: ENTITY,
        entityRef: poId,
      });
      await tx.commit();
    } catch (e) {
      await tx.rollback().catch(() => {});
      throw e;
    }
    res.json({ po_id: poId, deleted: true });
  } catch (err) { next(err); }
}

module.exports = { list, tabs, options, create, update, remove };
