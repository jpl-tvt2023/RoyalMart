const db = require('../config/db');
const { USER_HISTORY_RETENTION_DAYS } = require('../services/auditLog.service');

// Foreign-key fields per entity type, mapped to the source table they reference.
// Their stored IDs are resolved to human-readable labels before returning.
const FK_FIELDS = {
  marketplace_po: { office_poc: 'users', warehouse_poc: 'users', courier_id: 'couriers' },
  product_vendor_code: { product_id: 'products' },
  outbound_po: { approved_by: 'users', company_id: 'companies' },
  // Receipt edits are logged against the parent line, so checked_by changes
  // surface here rather than under a receipt-specific entity type.
  outbound_po_line: { checked_by: 'users' },
};

// How to label a row from each source table: which column holds the display value.
const TABLE_LABEL = {
  users: 'name',
  couriers: 'name',
  products: 'sku_code',
  companies: 'name',
};

// Resolve all FK IDs referenced across the given change-sets to labels, then
// rewrite each change's old/new value in place. Null stays null; an unknown id
// falls back to its raw value.
async function resolveForeignKeys(entityType, historyEntries) {
  const fkMap = FK_FIELDS[entityType];
  if (!fkMap) return;

  // Collect referenced ids per source table.
  const idsByTable = {}; // table -> Set of ids
  for (const entry of historyEntries) {
    for (const c of entry.changes) {
      const table = fkMap[c.field];
      if (!table) continue;
      (idsByTable[table] ||= new Set());
      for (const v of [c.old, c.new]) {
        if (v != null && v !== '') idsByTable[table].add(Number(v));
      }
    }
  }

  // Batch-load labels for each table.
  const labelByTableId = {}; // table -> Map(id -> label)
  for (const [table, idSet] of Object.entries(idsByTable)) {
    const ids = [...idSet].filter(Number.isFinite);
    if (!ids.length) continue;
    const labelCol = TABLE_LABEL[table] || 'name';
    const placeholders = ids.map(() => '?').join(',');
    const { rows } = await db.execute({
      sql: `SELECT id, ${labelCol} AS label FROM ${table} WHERE id IN (${placeholders})`,
      args: ids,
    });
    labelByTableId[table] = new Map(rows.map(r => [r.id, r.label]));
  }

  // Rewrite values.
  for (const entry of historyEntries) {
    for (const c of entry.changes) {
      const table = fkMap[c.field];
      if (!table) continue;
      const map = labelByTableId[table];
      const toLabel = (v) => {
        if (v == null || v === '') return v;
        return (map && map.get(Number(v))) ?? v;
      };
      c.old = toLabel(c.old);
      c.new = toLabel(c.new);
    }
  }
}

// GET /api/audit-logs?entity_type=marketplace_po&entity_id=RM-001
// Returns the change history for a single record, newest first.
async function getEntityHistory(req, res) {
  const entityType = req.query.entity_type;
  const entityId = req.query.entity_id;
  if (!entityType || entityId == null || entityId === '') {
    return res.status(400).json({ message: 'entity_type and entity_id are required' });
  }

  // entity_id may be numeric (most tables) or textual (marketplace_pos.po_id),
  // so match against both the INTEGER entity_id and the TEXT entity_ref.
  const key = String(entityId);
  // User account history is retention-limited to the last N days; other entity
  // types keep their full history.
  const retentionClause = String(entityType) === 'user'
    ? `AND a.timestamp >= datetime('now', '-${USER_HISTORY_RETENTION_DAYS} days')`
    : '';
  const { rows } = await db.execute({
    sql: `SELECT a.id, a.action_type, a.description, a.entity_type, a.entity_id,
                 a.entity_ref, a.changes, a.timestamp, a.user_id, u.name AS user_name
          FROM audit_logs a
          LEFT JOIN users u ON u.id = a.user_id
          WHERE a.entity_type = ?
            AND (CAST(a.entity_id AS TEXT) = ? OR a.entity_ref = ?)
            ${retentionClause}
          ORDER BY a.timestamp DESC, a.id DESC`,
    args: [String(entityType), key, key],
  });

  const history = rows.map(r => ({
    ...r,
    changes: r.changes ? JSON.parse(r.changes) : [],
  }));
  await resolveForeignKeys(String(entityType), history);
  res.json(history);
}

module.exports = { getEntityHistory };
