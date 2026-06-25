const db = require('../config/db');

// User account change history is retained for this many days; older `user`
// audit entries are purged (other entity types keep their full history).
const USER_HISTORY_RETENTION_DAYS = 31;
// Throttle the opportunistic purge so it runs at most once per hour per process
// (the prod backend is serverless, so we can't rely on a long-running cron there).
const PURGE_THROTTLE_MS = 60 * 60 * 1000;
let lastPurgeAt = 0;

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

  // Opportunistic, fire-and-forget retention cleanup — never blocks the write.
  maybePurgeUserHistory().catch(() => {});
}

/**
 * Delete `user` audit entries older than the retention window. Idempotent and
 * cheap (indexed on entity_type, timestamp). Returns the number of rows removed.
 */
async function purgeUserHistory() {
  const { rowsAffected } = await db.execute({
    sql: `DELETE FROM audit_logs
          WHERE entity_type = 'user'
            AND timestamp < datetime('now', ?)`,
    args: [`-${USER_HISTORY_RETENTION_DAYS} days`],
  });
  return rowsAffected || 0;
}

// Run purgeUserHistory at most once per throttle window per process.
async function maybePurgeUserHistory() {
  const now = Date.now();
  if (now - lastPurgeAt < PURGE_THROTTLE_MS) return;
  lastPurgeAt = now;
  await purgeUserHistory();
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

module.exports = { logAction, diffFields, purgeUserHistory, USER_HISTORY_RETENTION_DAYS };
