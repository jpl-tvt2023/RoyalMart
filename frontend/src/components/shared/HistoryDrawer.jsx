import { useEffect, useState } from 'react';
import { History } from 'lucide-react';
import Modal from '../ui/Modal';
import { getEntityHistory } from '../../api/audit.api';
import { formatDate, formatDateTime } from '../../utils/formatters';

function humanizeField(f) {
  return String(f)
    .replace(/_/g, ' ')
    .replace(/\bid\b/i, 'ID')
    .replace(/\b\w/g, c => c.toUpperCase());
}

// Fields stored as 0/1 booleans, with their on/off labels.
const BOOLEAN_FIELDS = {
  is_active: ['Active', 'Inactive'],
  has_parser: ['Yes', 'No'],
  mfa_enabled: ['Yes', 'No'],
};

function displayValue(field, v) {
  if (v === null || v === undefined || v === '') return '—';
  const bool = BOOLEAN_FIELDS[field];
  if (bool) {
    const truthy = v === 1 || v === '1' || v === true || v === 'true';
    return truthy ? bool[0] : bool[1];
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(v))) return formatDate(v);
  return String(v);
}

/**
 * Per-record change-history viewer. Opens a modal listing audit entries
 * (who / when / action) with the field-level old → new diff for each.
 */
export default function HistoryDrawer({ open, onClose, entityType, entityId, title = 'Change History' }) {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open || entityId == null) return;
    setLoading(true);
    setError(null);
    getEntityHistory(entityType, entityId)
      .then(setEntries)
      .catch(() => setError('Failed to load history'))
      .finally(() => setLoading(false));
  }, [open, entityType, entityId]);

  return (
    <Modal isOpen={open} onClose={onClose} title={title} size="lg">
      {loading && <p className="text-sm text-gray-400 py-6 text-center">Loading history…</p>}
      {error && <p className="text-sm text-red-500 py-6 text-center">{error}</p>}
      {!loading && !error && entries.length === 0 && (
        <p className="text-sm text-gray-400 py-6 text-center">No history recorded yet.</p>
      )}
      <ol className="relative border-l border-gray-200 ml-2">
        {entries.map(e => (
          <li key={e.id} className="mb-5 ml-4">
            <span className="absolute -left-1.5 mt-1.5 w-3 h-3 rounded-full bg-[#003049]" />
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-sm font-semibold text-gray-900">{e.user_name || 'System'}</span>
              <span className="text-xs text-gray-400">{formatDateTime(e.timestamp)}</span>
            </div>
            <p className="text-xs text-gray-500 mb-1">{e.description || e.action_type}</p>
            {Array.isArray(e.changes) && e.changes.length > 0 && (
              <div className="mt-1 space-y-0.5">
                {e.changes.map((c, i) => (
                  <div key={i} className="text-xs flex flex-wrap items-center gap-1">
                    <span className="font-medium text-gray-700">{humanizeField(c.field)}:</span>
                    <span className="line-through text-red-500">{displayValue(c.field, c.old)}</span>
                    <span className="text-gray-400">→</span>
                    <span className="text-green-600">{displayValue(c.field, c.new)}</span>
                  </div>
                ))}
              </div>
            )}
          </li>
        ))}
      </ol>
    </Modal>
  );
}

/** Small inline button that opens a HistoryDrawer for one record. */
export function HistoryButton({ entityType, entityId, title, className = '' }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="View change history"
        className={`p-1.5 rounded hover:bg-gray-100 text-gray-500 transition-colors ${className}`}
      >
        <History size={14} />
      </button>
      <HistoryDrawer open={open} onClose={() => setOpen(false)} entityType={entityType} entityId={entityId} title={title} />
    </>
  );
}
