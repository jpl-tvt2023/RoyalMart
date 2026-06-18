import { useEffect, useState, useCallback } from 'react';
import toast from 'react-hot-toast';
import { AlertTriangle, CheckCircle2, History, Undo2 } from 'lucide-react';
import AppShell from '../../components/layout/AppShell';
import Button from '../../components/ui/Button';
import Modal from '../../components/ui/Modal';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import { useRBAC } from '../../hooks/useRBAC';
import { formatDateTime } from '../../utils/formatters';
import { getRequirements, markOrdered, listBatches, undoBatch } from '../../api/procurement.api';

const EMPTY = { raw_products: [], po_count: 0, date_min: null, date_max: null, unmapped_line_count: 0, unmapped_samples: [] };

export default function ProcurementPage() {
  const { canEdit } = useRBAC();

  const [data, setData] = useState(EMPTY);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({ po_date_from: '', po_date_to: '' });
  const [confirmMark, setConfirmMark] = useState(false);
  const [marking, setMarking] = useState(false);

  const [historyOpen, setHistoryOpen] = useState(false);
  const [batches, setBatches] = useState([]);
  const [batchesLoading, setBatchesLoading] = useState(false);
  const [undoingId, setUndoingId] = useState(null);

  const load = useCallback((f = filters) => {
    setLoading(true);
    const params = {};
    if (f.po_date_from) params.po_date_from = f.po_date_from;
    if (f.po_date_to) params.po_date_to = f.po_date_to;
    getRequirements(params)
      .then(setData)
      .catch(() => toast.error('Failed to load procurement requirements'))
      .finally(() => setLoading(false));
  }, [filters]);

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const applyFilters = () => { load(filters); };
  const clearFilters = () => { const f = { po_date_from: '', po_date_to: '' }; setFilters(f); load(f); };

  const loadBatches = () => {
    setBatchesLoading(true);
    listBatches()
      .then(setBatches)
      .catch(() => toast.error('Failed to load history'))
      .finally(() => setBatchesLoading(false));
  };
  const openHistory = () => { setHistoryOpen(true); loadBatches(); };

  const doMark = async () => {
    setMarking(true);
    try {
      const r = await markOrdered({
        po_date_from: filters.po_date_from || undefined,
        po_date_to: filters.po_date_to || undefined,
      });
      toast.success(`Marked ${r.po_count} PO${r.po_count !== 1 ? 's' : ''} as ordered`);
      setConfirmMark(false);
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to mark as ordered');
    } finally { setMarking(false); }
  };

  const doUndo = async (batch) => {
    setUndoingId(batch.id);
    try {
      const r = await undoBatch(batch.id);
      toast.success(`Returned ${r.po_count} PO${r.po_count !== 1 ? 's' : ''} to pending`);
      loadBatches();
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Undo failed');
    } finally { setUndoingId(null); }
  };

  const inputCls = 'w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f]';
  const span = data.date_min && data.date_max
    ? (data.date_min === data.date_max ? data.date_min : `${data.date_min} – ${data.date_max}`)
    : '—';

  return (
    <AppShell>
      <div className="flex items-start justify-between mb-4 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#003049]">Procurement</h1>
          <p className="text-gray-500 text-sm">Raw materials required to fulfil the POs you haven&apos;t ordered for yet.</p>
        </div>
        <Button variant="outline" onClick={openHistory}><History size={16} />Ordered history</Button>
      </div>

      {/* Summary + filters */}
      <div className="bg-white border border-gray-200 rounded-xl p-4 mb-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-full sm:w-44">
            <label className="block text-xs font-medium text-gray-600 mb-1">PO Date From</label>
            <input type="date" value={filters.po_date_from} onChange={e => setFilters(f => ({ ...f, po_date_from: e.target.value }))} className={inputCls} />
          </div>
          <div className="w-full sm:w-44">
            <label className="block text-xs font-medium text-gray-600 mb-1">PO Date To</label>
            <input type="date" value={filters.po_date_to} onChange={e => setFilters(f => ({ ...f, po_date_to: e.target.value }))} className={inputCls} />
          </div>
          <Button variant="outline" onClick={applyFilters}>Apply</Button>
          <Button variant="ghost" onClick={clearFilters}>Clear</Button>
          <div className="ml-auto flex items-end">
            {canEdit && (
              <Button onClick={() => setConfirmMark(true)} disabled={loading || data.po_count === 0}>
                <CheckCircle2 size={16} />Mark as ordered
              </Button>
            )}
          </div>
        </div>
        <div className="mt-3 pt-3 border-t border-gray-100 text-sm text-gray-600">
          <span className="font-semibold text-[#003049]">{data.po_count}</span> pending PO{data.po_count !== 1 ? 's' : ''} in scope
          <span className="text-gray-400"> · PO dates {span}</span>
        </div>
      </div>

      {/* Unmapped warning */}
      {data.unmapped_line_count > 0 && (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <div>
            <span className="font-medium">{data.unmapped_line_count} PO line{data.unmapped_line_count !== 1 ? 's' : ''}</span> couldn&apos;t be matched to a SKU with requirements and {data.unmapped_line_count !== 1 ? 'are' : 'is'} not counted below. Add the missing vendor mapping or SKU requirements.
            {data.unmapped_samples?.length > 0 && (
              <span className="block text-xs text-amber-700 mt-1">
                e.g. {data.unmapped_samples.map(s => `${s.vendor}/${s.item_code}`).join(', ')}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Raw products table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="px-4 py-3 text-left font-semibold text-gray-600">Raw Product</th>
                <th className="px-4 py-3 text-left font-semibold text-gray-600">Required Qty</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                [...Array(5)].map((_, i) => (
                  <tr key={i}><td colSpan={2} className="px-4 py-3"><div className="h-4 bg-gray-100 rounded animate-pulse" /></td></tr>
                ))
              ) : data.raw_products.map(r => (
                <tr key={r.raw_product_id} className="border-b border-gray-100 hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3 font-medium text-gray-900">{r.name}</td>
                  <td className="px-4 py-3 text-gray-800 font-semibold">{Number(r.required_qty).toLocaleString('en-IN')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && data.raw_products.length === 0 && (
            <p className="text-center text-gray-400 py-8">
              {data.po_count === 0 ? 'No pending POs — nothing to procure.' : 'No raw-material requirements could be derived for the POs in scope.'}
            </p>
          )}
        </div>
      </div>

      <ConfirmDialog
        isOpen={confirmMark}
        onClose={() => setConfirmMark(false)}
        onConfirm={doMark}
        title="Mark POs as ordered"
        message={`Mark ${data.po_count} PO${data.po_count !== 1 ? 's' : ''}${span !== '—' ? ` (PO dates ${span})` : ''} as raw-ordered? They'll be removed from this list. You can undo this from Ordered history.`}
        confirmLabel="Mark as ordered"
        loading={marking}
      />

      <Modal isOpen={historyOpen} onClose={() => setHistoryOpen(false)} title="Ordered history" size="lg">
        {batchesLoading ? (
          <div className="space-y-2">{[...Array(3)].map((_, i) => <div key={i} className="h-10 bg-gray-100 rounded animate-pulse" />)}</div>
        ) : batches.length === 0 ? (
          <p className="text-center text-gray-400 py-6">No batches marked as ordered yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="px-3 py-2 text-left font-semibold text-gray-600">When</th>
                  <th className="px-3 py-2 text-left font-semibold text-gray-600">PO Date Range</th>
                  <th className="px-3 py-2 text-left font-semibold text-gray-600">POs</th>
                  <th className="px-3 py-2 text-left font-semibold text-gray-600">By</th>
                  {canEdit && <th className="px-3 py-2" />}
                </tr>
              </thead>
              <tbody>
                {batches.map(b => (
                  <tr key={b.id} className="border-b border-gray-100">
                    <td className="px-3 py-2 whitespace-nowrap text-gray-700">{formatDateTime(b.created_at)}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-gray-600">{b.po_date_from || '…'} – {b.po_date_to || '…'}</td>
                    <td className="px-3 py-2 font-semibold text-gray-800">{b.po_count}</td>
                    <td className="px-3 py-2 text-gray-600">{b.created_by_name || '—'}</td>
                    {canEdit && (
                      <td className="px-3 py-2 text-right">
                        <button
                          onClick={() => doUndo(b)}
                          disabled={undoingId === b.id}
                          className="inline-flex items-center gap-1 text-sm text-[#c1121f] hover:underline disabled:opacity-40"
                        >
                          <Undo2 size={14} />Undo
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Modal>
    </AppShell>
  );
}
