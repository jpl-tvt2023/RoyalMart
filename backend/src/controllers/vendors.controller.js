const db = require('../config/db');
const { logAction, diffFields } = require('../services/auditLog.service');
const { hasParser } = require('../parsers/marketplacePO');

function normName(v) {
  return v == null ? '' : String(v).trim();
}

// PO Prefix (097): the letters a vendor's PO ids start with -- MY for MY001.
// Letters only, so letters-then-digits splits one way and two prefixes can
// never mint the same id. One to three of them, stored upper-case, UNIQUE.
const PO_PREFIX_RE = /^[A-Z]{1,3}$/;
const normPrefix = (v) => (v == null ? '' : String(v).trim().toUpperCase());
// P is taken by Balaji Builty's own ids (P001, migration 108), which live in a
// table of their own -- a vendor on P would mint a second, different P001.
const RESERVED_PREFIXES = { P: 'Balaji Builty' };
const prefixError = (p) => {
  if (!PO_PREFIX_RE.test(p)) return 'PO Prefix must be 1 to 3 letters (A-Z)';
  if (RESERVED_PREFIXES[p]) return `PO Prefix "${p}" is reserved for ${RESERVED_PREFIXES[p]}`;
  return null;
};

// Any PO at all, Deleted included -- a deleted PO keeps its id and can come back.
async function hasPos(name) {
  const { rows } = await db.execute({
    sql: 'SELECT 1 FROM marketplace_pos WHERE vendor = ? LIMIT 1',
    args: [name],
  });
  return rows.length > 0;
}

// 409 with the vendor that holds the prefix, or null when it is free.
async function prefixTaken(prefix, exceptId = null) {
  const { rows } = await db.execute({
    sql: 'SELECT name FROM vendors WHERE po_prefix = ? AND id IS NOT ?',
    args: [prefix, exceptId],
  });
  return rows.length ? `PO Prefix "${prefix}" is already used by ${rows[0].name}` : null;
}

// The UNIQUE constraint that fired -- name or po_prefix -- as the 409 message.
function uniqueMessage(err) {
  if (!err.message || !err.message.includes('UNIQUE constraint failed')) return null;
  return err.message.includes('po_prefix')
    ? 'That PO Prefix is already used by another vendor'
    : 'A vendor with that name already exists';
}

async function list(req, res, next) {
  try {
    const { rows } = await db.execute(
      `SELECT v.id, v.name, v.is_active, v.has_parser, v.po_prefix, v.created_at, v.updated_at,
              u.name AS updated_by_name,
              EXISTS (SELECT 1 FROM marketplace_pos p WHERE p.vendor = v.name) AS has_pos
       FROM vendors v
       LEFT JOIN users u ON u.id = v.updated_by
       ORDER BY v.is_active DESC, v.name ASC`
    );
    res.json(rows);
  } catch (err) { next(err); }
}

async function create(req, res, next) {
  try {
    const name = normName(req.body?.name);
    if (!name) return res.status(400).json({ message: 'name is required' });
    const poPrefix = normPrefix(req.body?.po_prefix);
    if (!poPrefix) return res.status(400).json({ message: 'PO Prefix is required' });
    const pErr = prefixError(poPrefix);
    if (pErr) return res.status(400).json({ message: pErr });
    const taken = await prefixTaken(poPrefix);
    if (taken) return res.status(409).json({ message: taken });

    const parserAvailable = hasParser(name) ? 1 : 0;
    const { rows } = await db.execute({
      sql: `INSERT INTO vendors (name, has_parser, po_prefix) VALUES (?, ?, ?)
            RETURNING id, name, is_active, has_parser, po_prefix, created_at`,
      args: [name, parserAvailable, poPrefix],
    });
    await logAction({
      userId: req.user.id,
      actionType: 'VENDOR_CREATE',
      description: `Added vendor "${name}" (PO prefix ${poPrefix}, parser=${parserAvailable ? 'yes' : 'no'})`,
      entityType: 'vendor',
      entityId: rows[0].id,
    });
    res.status(201).json(rows[0]);
  } catch (err) {
    const msg = uniqueMessage(err);
    if (msg) return res.status(409).json({ message: msg });
    next(err);
  }
}

async function update(req, res, next) {
  try {
    const { id } = req.params;
    const has = (k) => Object.prototype.hasOwnProperty.call(req.body || {}, k);
    const { rows: existing } = await db.execute({
      sql: 'SELECT id, name, is_active, has_parser, po_prefix FROM vendors WHERE id = ?',
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

    // The prefix is settable while the vendor has no PO, and fixed after: the
    // ids already minted carry it. A vendor 097 left without one (it shared a
    // first letter) may always be given one. Once set it cannot be blanked.
    let nextPrefix = current.po_prefix;
    if (has('po_prefix')) {
      const p = normPrefix(req.body.po_prefix) || null;
      if (p !== (current.po_prefix || null)) {
        if (!p) return res.status(400).json({ message: 'PO Prefix is required' });
        const pErr = prefixError(p);
        if (pErr) return res.status(400).json({ message: pErr });
        if (current.po_prefix && await hasPos(current.name)) {
          return res.status(409).json({
            message: `PO Prefix cannot change once "${current.name}" has POs`,
          });
        }
        const taken = await prefixTaken(p, Number(id));
        if (taken) return res.status(409).json({ message: taken });
        nextPrefix = p;
      }
    }

    // `has_parser` is derived from the codebase (the parser registry) and
    // therefore re-evaluated on every update — admins cannot toggle it manually.
    const nextHasParser = hasParser(nextName) ? 1 : 0;

    const changes = diffFields(
      current,
      { name: nextName, is_active: nextActive, has_parser: nextHasParser, po_prefix: nextPrefix },
      ['name', 'is_active', 'has_parser', 'po_prefix'],
    );
    const { rows } = await db.execute({
      sql: `UPDATE vendors SET name = ?, is_active = ?, has_parser = ?, po_prefix = ?,
              updated_by = ?, updated_at = datetime('now')
            WHERE id = ?
            RETURNING id, name, is_active, has_parser, po_prefix, created_at, updated_at`,
      args: [nextName, nextActive, nextHasParser, nextPrefix, req.user.id, id],
    });
    await logAction({
      userId: req.user.id,
      actionType: 'VENDOR_UPDATE',
      description: `Updated vendor #${id}: name="${nextName}", prefix=${nextPrefix || '—'}, active=${nextActive}, parser=${nextHasParser}`,
      entityType: 'vendor',
      entityId: id,
      changes,
    });
    res.json(rows[0]);
  } catch (err) {
    const msg = uniqueMessage(err);
    if (msg) return res.status(409).json({ message: msg });
    next(err);
  }
}

async function remove(req, res, next) {
  try {
    const { id } = req.params;
    const { rows: existing } = await db.execute({
      sql: 'SELECT id, name FROM vendors WHERE id = ?',
      args: [id],
    });
    if (!existing.length) return res.status(404).json({ message: 'Vendor not found' });

    const { rows: refs } = await db.execute({
      sql: "SELECT COUNT(*) AS n FROM marketplace_pos WHERE vendor = ? AND status <> 'Deleted'",
      args: [existing[0].name],
    });
    if (Number(refs[0]?.n) > 0) {
      return res.status(409).json({
        message: `Vendor "${existing[0].name}" has ${refs[0].n} PO(s) and cannot be deactivated. Reassign or delete those POs first.`,
      });
    }

    const { rows } = await db.execute({
      sql: 'UPDATE vendors SET is_active = 0 WHERE id = ? RETURNING id, name, is_active, has_parser, created_at',
      args: [id],
    });
    await logAction({
      userId: req.user.id,
      actionType: 'VENDOR_DEACTIVATE',
      description: `Deactivated vendor "${existing[0].name}"`,
      entityType: 'vendor',
      entityId: id,
    });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

module.exports = { list, create, update, remove };
