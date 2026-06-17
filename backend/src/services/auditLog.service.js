const db = require('../config/db');

/**
 * Record an audit entry. `changes` is an optional array of
 * { field, old, new } objects describing the field-level diff; it is
 * stored as JSON in audit_logs.changes for the per-record history view.
 */
async function logAction({ client, userId, actionType, description, entityType, entityId, entityRef, changes }) {
  const executor = client || db;
  await executor.execute({
    sql: `INSERT INTO audit_logs (user_id, action_type, description, entity_type, entity_id, entity_ref, changes)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      userId || null,
      actionType,
      description || null,
      entityType || null,
      entityId || null,
      entityRef != null ? String(entityRef) : null,
      changes && changes.length ? JSON.stringify(changes) : null,
    ],
  });
}

/**
 * Compare a before/after object over the given fields and return the
 * changed entries as [{ field, old, new }]. Values are compared loosely
 * by string form so 1 vs '1' and null vs undefined don't register as edits.
 */
function diffFields(before, after, fields) {
  const norm = (v) => (v == null ? null : String(v));
  const changes = [];
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(after, field)) continue;
    const oldVal = before ? before[field] : null;
    const newVal = after[field];
    if (norm(oldVal) !== norm(newVal)) {
      changes.push({ field, old: oldVal ?? null, new: newVal ?? null });
    }
  }
  return changes;
}

module.exports = { logAction, diffFields };
