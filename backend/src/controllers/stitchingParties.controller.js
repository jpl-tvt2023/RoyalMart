// The stitching party master: who does the job work, and who buys finished
// goods off us.
//
// Migration 079 explains why this is not outbound_vendors. What it adds over a
// plain name master is the USE TAGS -- the destinations each party may serve --
// which is what lets the challan form offer only parties that can legitimately
// do the job being dispatched. A party with no tags exists but is never offered,
// which is the state migration 079's backfill leaves every imported name in.
const db = require('../config/db');
const { logAction, diffFields } = require('../services/auditLog.service');
const { PARTY_USE_STAGES, isValidPartyUse } = require('../services/stitching.service');

const NAME_MAX = 50;

// The short form shown on the Stitching page as "Stitching - SKT". Optional:
// blank falls back to the party's initials (partyShort in stitching.service.js),
// so it only needs filling in where the initials are ambiguous or unhelpful.
const SHORT_NAME_MAX = 10;

function normName(v) {
  return v == null ? '' : String(v).trim();
}

function shortNameError(v) {
  const s = normName(v);
  if (s.length > SHORT_NAME_MAX) return `Short Name must be ${SHORT_NAME_MAX} characters or less`;
  return null;
}

// Returns a de-duplicated, canonically ordered list, or an error string. Order
// is PARTY_USE_STAGES order rather than the order the client sent, so two
// clients ticking the same boxes produce the same stored value and diffFields
// does not report a change that nobody made.
function validateUses(raw) {
  if (raw == null) return { uses: [], error: null };
  if (!Array.isArray(raw)) return { uses: null, error: 'Valid for must be a list of stages' };
  const seen = new Set();
  for (const u of raw) {
    const s = normName(u);
    if (!isValidPartyUse(s)) {
      return { uses: null, error: `Valid for must be any of ${PARTY_USE_STAGES.join(', ')}` };
    }
    seen.add(s);
  }
  return { uses: PARTY_USE_STAGES.filter(s => seen.has(s)), error: null };
}

// How many live challans name this party. Matched on party_name rather than a
// FK because Phase 1 has no party_id yet -- migration 082 adds it and this
// switches to counting on the id. NOCASE so a case-variant spelling still counts
// as a reference, which is the conservative answer for a guard.
async function referenceCount(name, client) {
  const executor = client || db;
  const { rows } = await executor.execute({
    sql: `SELECT COUNT(*) AS n FROM stitching_entries
           WHERE deleted_at IS NULL AND party_name = ? COLLATE NOCASE`,
    args: [name],
  });
  return Number(rows[0]?.n) || 0;
}

const outward = (row) => ({
  ...row,
  // group_concat returns NULL for a party with no tags, not an empty string.
  uses: row.uses ? String(row.uses).split(',') : [],
});

async function list(req, res, next) {
  try {
    const { rows } = await db.execute(
      `SELECT p.id, p.name, p.short_name, p.is_active, p.created_at, p.updated_at,
              u.name AS updated_by_name,
              (SELECT group_concat(x.use_stage, ',')
                 FROM (SELECT use_stage FROM stitching_party_uses
                        WHERE party_id = p.id ORDER BY use_stage) x) AS uses,
              (SELECT COUNT(*) FROM stitching_entries e
                WHERE e.deleted_at IS NULL AND e.party_name = p.name COLLATE NOCASE) AS in_use
         FROM stitching_parties p
         LEFT JOIN users u ON u.id = p.updated_by
        ORDER BY p.is_active DESC, p.name ASC`
    );
    res.json(rows.map(outward));
  } catch (err) { next(err); }
}

async function create(req, res, next) {
  const tx = await db.transaction('write');
  try {
    const name = normName(req.body?.name);
    if (!name) { await tx.rollback(); return res.status(400).json({ message: 'Name is required' }); }
    if (name.length > NAME_MAX) {
      await tx.rollback();
      return res.status(400).json({ message: `Name must be ${NAME_MAX} characters or less` });
    }
    const shortErr = shortNameError(req.body?.short_name);
    if (shortErr) { await tx.rollback(); return res.status(400).json({ message: shortErr }); }
    const shortName = normName(req.body?.short_name) || null;
    const { uses, error } = validateUses(req.body?.uses);
    if (error) { await tx.rollback(); return res.status(400).json({ message: error }); }

    const { rows } = await tx.execute({
      sql: `INSERT INTO stitching_parties (name, short_name, updated_by)
            VALUES (?, ?, ?) RETURNING id, name, short_name, is_active, created_at`,
      args: [name, shortName, req.user.id],
    });
    const party = rows[0];
    for (const u of uses) {
      await tx.execute({
        sql: 'INSERT INTO stitching_party_uses (party_id, use_stage) VALUES (?, ?)',
        args: [party.id, u],
      });
    }
    await logAction({
      client: tx,
      userId: req.user.id,
      actionType: 'STITCHING_PARTY_CREATE',
      description: `Added stitching party "${name}"${uses.length ? ` for ${uses.join(', ')}` : ' with no uses tagged yet'}`,
      entityType: 'stitching_party',
      entityId: party.id,
      entityRef: name,
    });
    await tx.commit();
    res.status(201).json({ ...party, uses });
  } catch (err) {
    await tx.rollback();
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ message: 'A party with that name already exists' });
    }
    next(err);
  }
}

async function update(req, res, next) {
  const tx = await db.transaction('write');
  try {
    const { id } = req.params;
    const has = (k) => Object.prototype.hasOwnProperty.call(req.body || {}, k);
    const { rows: existing } = await tx.execute({
      sql: `SELECT p.id, p.name, p.short_name, p.is_active,
                   (SELECT group_concat(x.use_stage, ',')
                      FROM (SELECT use_stage FROM stitching_party_uses
                             WHERE party_id = p.id ORDER BY use_stage) x) AS uses
              FROM stitching_parties p WHERE p.id = ?`,
      args: [id],
    });
    if (!existing.length) {
      await tx.rollback();
      return res.status(404).json({ message: 'Party not found' });
    }
    const current = outward(existing[0]);

    let nextName = current.name;
    if (has('name')) {
      const n = normName(req.body.name);
      if (!n) { await tx.rollback(); return res.status(400).json({ message: 'Name cannot be empty' }); }
      if (n.length > NAME_MAX) {
        await tx.rollback();
        return res.status(400).json({ message: `Name must be ${NAME_MAX} characters or less` });
      }
      nextName = n;
    }

    let nextShort = current.short_name ?? null;
    if (has('short_name')) {
      const err = shortNameError(req.body.short_name);
      if (err) { await tx.rollback(); return res.status(400).json({ message: err }); }
      nextShort = normName(req.body.short_name) || null;
    }

    let nextUses = current.uses;
    if (has('uses')) {
      const { uses, error } = validateUses(req.body.uses);
      if (error) { await tx.rollback(); return res.status(400).json({ message: error }); }
      nextUses = uses;
    }

    let nextActive = current.is_active;
    if (has('is_active')) nextActive = req.body.is_active ? 1 : 0;

    // Renaming is display-only for the master itself, but challans store
    // party_name as a denormalised copy, so past dispatches keep the spelling
    // they were raised under. That is the same trade outbound_po_lines makes
    // with its article fields, and it is why a rename is allowed while in use.
    const changes = diffFields(
      { name: current.name, short_name: current.short_name ?? null, is_active: current.is_active, uses: current.uses.join(', ') },
      { name: nextName, short_name: nextShort, is_active: nextActive, uses: nextUses.join(', ') },
      ['name', 'short_name', 'is_active', 'uses'],
    );

    const { rows } = await tx.execute({
      sql: `UPDATE stitching_parties SET name = ?, short_name = ?, is_active = ?, updated_by = ?,
              updated_at = datetime('now')
            WHERE id = ? RETURNING id, name, short_name, is_active, created_at, updated_at`,
      args: [nextName, nextShort, nextActive, req.user.id, id],
    });

    if (has('uses')) {
      await tx.execute({ sql: 'DELETE FROM stitching_party_uses WHERE party_id = ?', args: [id] });
      for (const u of nextUses) {
        await tx.execute({
          sql: 'INSERT INTO stitching_party_uses (party_id, use_stage) VALUES (?, ?)',
          args: [id, u],
        });
      }
    }

    await logAction({
      client: tx,
      userId: req.user.id,
      actionType: 'STITCHING_PARTY_UPDATE',
      description: `Updated stitching party #${id}: name="${nextName}", valid for ${nextUses.join(', ') || 'nothing yet'}, active=${nextActive}`,
      entityType: 'stitching_party',
      entityId: id,
      entityRef: nextName,
      changes,
    });
    await tx.commit();
    res.json({ ...rows[0], uses: nextUses });
  } catch (err) {
    await tx.rollback();
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ message: 'A party with that name already exists' });
    }
    next(err);
  }
}

// Deactivate rather than delete, like every other master here. Challans already
// raised against the party keep their denormalised party_name and read exactly
// as before -- the name simply stops being offered for new ones. Hence no
// in-use guard: there is nothing a deactivation can break.
async function remove(req, res, next) {
  try {
    const { id } = req.params;
    const { rows: existing } = await db.execute({
      sql: 'SELECT id, name FROM stitching_parties WHERE id = ?',
      args: [id],
    });
    if (!existing.length) return res.status(404).json({ message: 'Party not found' });
    const { rows } = await db.execute({
      sql: `UPDATE stitching_parties SET is_active = 0, updated_by = ?, updated_at = datetime('now')
            WHERE id = ? RETURNING id, name, is_active, created_at`,
      args: [req.user.id, id],
    });
    await logAction({
      userId: req.user.id,
      actionType: 'STITCHING_PARTY_DEACTIVATE',
      description: `Deactivated stitching party "${existing[0].name}"`,
      entityType: 'stitching_party',
      entityId: id,
      entityRef: existing[0].name,
    });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

module.exports = { list, create, update, remove, referenceCount, validateUses, NAME_MAX, SHORT_NAME_MAX };
