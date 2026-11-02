const db = require('../config/db');
const { logAction, diffFields } = require('../services/auditLog.service');
const { STOCK_STAGE } = require('../services/stitching.service');

// THE WAREHOUSES MASTER (migration 096). Each row is one of our own warehouses:
// a tab on the Stitching page, a destination tile on the challan form and a
// stage option on the receipt form, all under the one Warehouse stage.
//
// A lot is never stamped with its warehouse. It points at an incoming prefix,
// and each Warehouse prefix belongs to one warehouse -- so renaming a warehouse
// here renames it on every lot at once, and deactivating it only stops it being
// offered for new goods. Stock already there stays where it is.

const NAME_MAX = 50;
// The short form the warehouse's own gate number prints under ("PCL Inc No"),
// so it has to fit in a column header.
const CODE_MAX = 10;

const trimOrEmpty = (v) => (v == null ? '' : String(v).trim());

function nameError(name) {
  if (!name) return 'Warehouse name is required';
  if (name.length > NAME_MAX) return `Warehouse name must be ${NAME_MAX} characters or less`;
  return null;
}

function codeError(code) {
  if (!code) return 'Code is required';
  if (code.length > CODE_MAX) return `Code must be ${CODE_MAX} characters or less`;
  return null;
}

// Which UNIQUE constraint a failed write tripped, as a sentence about the field.
function uniqueMessage(err) {
  const msg = String(err?.message || '');
  if (!msg.includes('UNIQUE constraint failed')) return null;
  if (msg.includes('warehouses.name')) return 'A warehouse with that name already exists';
  if (msg.includes('warehouses.code')) return 'A warehouse with that code already exists';
  if (msg.includes('stitching_prefixes.prefix')) return 'A prefix with that code already exists';
  return 'That value is already in use';
}

// How many live lots sit in this warehouse -- receipts booked straight in and
// challans sent to it, both found through the warehouse's prefixes. The
// Stitching page keeps showing an inactive warehouse's tab while this is above
// zero, so its stock never goes out of sight.
const IN_USE_SQL = `
  (SELECT COUNT(*) FROM outbound_po_line_receipts r
     JOIN stitching_prefixes sp ON sp.id = r.incoming_prefix_id
    WHERE sp.warehouse_id = w.id AND r.deleted_at IS NULL)
+ (SELECT COUNT(*) FROM stitching_entries e
     JOIN stitching_prefixes sp ON sp.id = e.incoming_prefix_id
    WHERE sp.warehouse_id = w.id AND e.deleted_at IS NULL AND e.write_off_reason IS NULL)`;

async function list(req, res, next) {
  try {
    const { rows } = await db.execute(
      `SELECT w.id, w.name, w.code, w.is_active, w.created_at, w.updated_at,
              u.name AS updated_by_name,
              -- The codes this warehouse's goods are numbered under, active
              -- first: the one new goods get is the lowest-id active one.
              (SELECT GROUP_CONCAT(prefix, ', ') FROM (
                 SELECT sp.prefix FROM stitching_prefixes sp
                  WHERE sp.warehouse_id = w.id AND sp.is_active = 1 ORDER BY sp.id)) AS prefixes,
              ${IN_USE_SQL} AS in_use
       FROM warehouses w
       LEFT JOIN users u ON u.id = w.updated_by
       ORDER BY w.is_active DESC, w.id ASC`
    );
    res.json(rows);
  } catch (err) { next(err); }
}

// A new warehouse comes with its first incoming prefix, written in the same
// transaction: a warehouse with no prefix could not take a single lot, since
// every lot that arrives is numbered under one. Further prefixes, and renaming
// this one, are the Stitching Prefixes tab's job.
async function create(req, res, next) {
  try {
    const name = trimOrEmpty(req.body?.name);
    const code = trimOrEmpty(req.body?.code);
    const prefix = trimOrEmpty(req.body?.prefix);
    const err = nameError(name) || codeError(code) || (!prefix ? 'Incoming prefix is required' : null);
    if (err) return res.status(400).json({ message: err });

    const tx = await db.transaction('write');
    let created;
    try {
      const { rows } = await tx.execute({
        sql: `INSERT INTO warehouses (name, code, updated_by) VALUES (?, ?, ?)
              RETURNING id, name, code, is_active, created_at`,
        args: [name, code, req.user.id],
      });
      created = rows[0];
      const { rows: prefixRows } = await tx.execute({
        sql: `INSERT INTO stitching_prefixes (prefix, stage, warehouse_id, updated_by)
              VALUES (?, ?, ?, ?) RETURNING id`,
        args: [prefix, STOCK_STAGE, created.id, req.user.id],
      });
      await logAction({
        client: tx,
        userId: req.user.id,
        actionType: 'WAREHOUSE_CREATE',
        description: `Added warehouse "${name}" (${code}), numbered under ${prefix}`,
        entityType: 'warehouse',
        entityId: created.id,
        entityRef: name,
      });
      await logAction({
        client: tx,
        userId: req.user.id,
        actionType: 'STITCHING_PREFIX_CREATE',
        description: `Added stitching prefix "${prefix}" for warehouse ${name}`,
        entityType: 'stitching_prefix',
        entityId: prefixRows[0].id,
        entityRef: prefix,
      });
      await tx.commit();
    } catch (e) {
      await tx.rollback();
      throw e;
    }
    res.status(201).json(created);
  } catch (err) {
    const unique = uniqueMessage(err);
    if (unique) return res.status(409).json({ message: unique });
    next(err);
  }
}

// Name and code are labels -- every lot reads them through its prefix, so a
// rename shows everywhere at once and history keeps the old one. is_active only
// decides whether new goods may be sent here.
async function update(req, res, next) {
  try {
    const { id } = req.params;
    const has = (k) => Object.prototype.hasOwnProperty.call(req.body || {}, k);
    const { rows: existing } = await db.execute({
      sql: 'SELECT id, name, code, is_active FROM warehouses WHERE id = ?',
      args: [id],
    });
    if (!existing.length) return res.status(404).json({ message: 'Warehouse not found' });
    const current = existing[0];

    const nextName = has('name') ? trimOrEmpty(req.body.name) : current.name;
    const nextCode = has('code') ? trimOrEmpty(req.body.code) : current.code;
    const err = nameError(nextName) || codeError(nextCode);
    if (err) return res.status(400).json({ message: err });
    const nextActive = has('is_active') ? (req.body.is_active ? 1 : 0) : current.is_active;

    const changes = diffFields(
      current,
      { name: nextName, code: nextCode, is_active: nextActive },
      ['name', 'code', 'is_active'],
    );
    const { rows } = await db.execute({
      sql: `UPDATE warehouses SET name = ?, code = ?, is_active = ?, updated_by = ?,
              updated_at = datetime('now')
            WHERE id = ? RETURNING id, name, code, is_active, created_at, updated_at`,
      args: [nextName, nextCode, nextActive, req.user.id, id],
    });
    await logAction({
      userId: req.user.id,
      actionType: 'WAREHOUSE_UPDATE',
      description: `Updated warehouse #${id}: name="${nextName}", code=${nextCode}, active=${nextActive}`,
      entityType: 'warehouse',
      entityId: id,
      entityRef: nextName,
      changes,
    });
    res.json(rows[0]);
  } catch (err) {
    const unique = uniqueMessage(err);
    if (unique) return res.status(409).json({ message: unique });
    next(err);
  }
}

// Deactivate rather than delete, like every other master. Stock already in the
// warehouse stays there and stays on its tab -- it simply stops being offered
// as somewhere to send or book new goods.
async function remove(req, res, next) {
  try {
    const { id } = req.params;
    const { rows: existing } = await db.execute({
      sql: 'SELECT id, name FROM warehouses WHERE id = ?',
      args: [id],
    });
    if (!existing.length) return res.status(404).json({ message: 'Warehouse not found' });
    const { rows } = await db.execute({
      sql: `UPDATE warehouses SET is_active = 0, updated_by = ?, updated_at = datetime('now')
            WHERE id = ? RETURNING id, name, code, is_active, created_at`,
      args: [req.user.id, id],
    });
    await logAction({
      userId: req.user.id,
      actionType: 'WAREHOUSE_DEACTIVATE',
      description: `Deactivated warehouse "${existing[0].name}"`,
      entityType: 'warehouse',
      entityId: id,
      entityRef: existing[0].name,
    });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

module.exports = { list, create, update, remove };
