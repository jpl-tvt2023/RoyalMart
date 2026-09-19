const db = require('../config/db');
const { logAction, diffFields } = require('../services/auditLog.service');
const { STAGES, isValidStage } = require('../services/stitching.service');

function normPrefix(v) {
  return v == null ? '' : String(v).trim();
}

// How many live lots were issued under this prefix. Used to decide whether the
// prefix's STAGE may still be changed -- see update() for why renaming is fine
// but re-staging is not.
async function referenceCount(id, client) {
  const executor = client || db;
  const { rows } = await executor.execute({
    sql: `SELECT
            (SELECT COUNT(*) FROM outbound_po_line_receipts
              WHERE incoming_prefix_id = ? AND deleted_at IS NULL)
          + (SELECT COUNT(*) FROM stitching_entries
              WHERE incoming_prefix_id = ? AND deleted_at IS NULL) AS n`,
    args: [id, id],
  });
  return Number(rows[0]?.n) || 0;
}

async function list(req, res, next) {
  try {
    const { rows } = await db.execute(
      `SELECT p.id, p.prefix, p.stage, p.is_active, p.created_at, p.updated_at,
              u.name AS updated_by_name,
              (SELECT COUNT(*) FROM outbound_po_line_receipts r
                WHERE r.incoming_prefix_id = p.id AND r.deleted_at IS NULL)
            + (SELECT COUNT(*) FROM stitching_entries e
                WHERE e.incoming_prefix_id = p.id AND e.deleted_at IS NULL) AS in_use
       FROM stitching_prefixes p
       LEFT JOIN users u ON u.id = p.updated_by
       ORDER BY p.is_active DESC, p.stage ASC, p.prefix ASC`
    );
    res.json(rows);
  } catch (err) { next(err); }
}

async function create(req, res, next) {
  try {
    const prefix = normPrefix(req.body?.prefix);
    if (!prefix) return res.status(400).json({ message: 'Prefix is required' });
    const stage = normPrefix(req.body?.stage);
    if (!isValidStage(stage)) {
      return res.status(400).json({ message: `Stage must be one of ${STAGES.join(', ')}` });
    }
    const { rows } = await db.execute({
      sql: `INSERT INTO stitching_prefixes (prefix, stage, updated_by)
            VALUES (?, ?, ?) RETURNING id, prefix, stage, is_active, created_at`,
      args: [prefix, stage, req.user.id],
    });
    await logAction({
      userId: req.user.id,
      actionType: 'STITCHING_PREFIX_CREATE',
      description: `Added stitching prefix "${prefix}" for stage ${stage}`,
      entityType: 'stitching_prefix',
      entityId: rows[0].id,
      entityRef: prefix,
    });
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ message: 'A prefix with that code already exists' });
    }
    next(err);
  }
}

async function update(req, res, next) {
  try {
    const { id } = req.params;
    const has = (k) => Object.prototype.hasOwnProperty.call(req.body || {}, k);
    const { rows: existing } = await db.execute({
      sql: 'SELECT id, prefix, stage, is_active FROM stitching_prefixes WHERE id = ?',
      args: [id],
    });
    if (!existing.length) return res.status(404).json({ message: 'Prefix not found' });
    const current = existing[0];

    let nextPrefix = current.prefix;
    if (has('prefix')) {
      const p = normPrefix(req.body.prefix);
      if (!p) return res.status(400).json({ message: 'Prefix cannot be empty' });
      nextPrefix = p;
    }

    let nextStageValue = current.stage;
    if (has('stage')) {
      const s = normPrefix(req.body.stage);
      if (!isValidStage(s)) {
        return res.status(400).json({ message: `Stage must be one of ${STAGES.join(', ')}` });
      }
      nextStageValue = s;
    }

    // Renaming is display-only -- every lot keeps its FK and simply shows the new
    // code. Re-staging is not: the prefix is what puts a lot on a particular tab,
    // and a lot's stage is also what its children were allowed to be forwarded
    // to. Moving it after the fact would silently relocate live lots and could
    // leave a chain running backwards, so it is refused while anything uses it.
    // Deactivate and add a correctly-staged prefix instead.
    if (nextStageValue !== current.stage) {
      const n = await referenceCount(id);
      if (n > 0) {
        return res.status(400).json({
          message: `Cannot change the stage of "${current.prefix}" — ${n} lot(s) were received under it. `
            + 'Deactivate it and add a new prefix for the other stage instead.',
        });
      }
    }

    let nextActive = current.is_active;
    if (has('is_active')) nextActive = req.body.is_active ? 1 : 0;

    const changes = diffFields(
      current,
      { prefix: nextPrefix, stage: nextStageValue, is_active: nextActive },
      ['prefix', 'stage', 'is_active'],
    );
    const { rows } = await db.execute({
      sql: `UPDATE stitching_prefixes SET prefix = ?, stage = ?, is_active = ?, updated_by = ?,
              updated_at = datetime('now')
            WHERE id = ? RETURNING id, prefix, stage, is_active, created_at, updated_at`,
      args: [nextPrefix, nextStageValue, nextActive, req.user.id, id],
    });
    await logAction({
      userId: req.user.id,
      actionType: 'STITCHING_PREFIX_UPDATE',
      description: `Updated stitching prefix #${id}: prefix="${nextPrefix}", stage=${nextStageValue}, active=${nextActive}`,
      entityType: 'stitching_prefix',
      entityId: id,
      entityRef: nextPrefix,
      changes,
    });
    res.json(rows[0]);
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ message: 'A prefix with that code already exists' });
    }
    next(err);
  }
}

// Deactivate rather than delete, like every other master in this app. A prefix
// still referenced by live lots stays referenced -- those rows keep displaying
// their incoming number correctly, the code simply stops being offered for new
// ones. That is why this needs no in-use guard where update()'s stage change does.
async function remove(req, res, next) {
  try {
    const { id } = req.params;
    const { rows: existing } = await db.execute({
      sql: 'SELECT id, prefix, stage FROM stitching_prefixes WHERE id = ?',
      args: [id],
    });
    if (!existing.length) return res.status(404).json({ message: 'Prefix not found' });
    const { rows } = await db.execute({
      sql: `UPDATE stitching_prefixes SET is_active = 0, updated_by = ?, updated_at = datetime('now')
            WHERE id = ? RETURNING id, prefix, stage, is_active, created_at`,
      args: [req.user.id, id],
    });
    await logAction({
      userId: req.user.id,
      actionType: 'STITCHING_PREFIX_DEACTIVATE',
      description: `Deactivated stitching prefix "${existing[0].prefix}" (${existing[0].stage})`,
      entityType: 'stitching_prefix',
      entityId: id,
      entityRef: existing[0].prefix,
    });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

module.exports = { list, create, update, remove, referenceCount };
