import { useEffect, useState, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import * as XLSX from 'xlsx';
import toast from 'react-hot-toast';
import { AlertTriangle, CheckCircle2, History, Undo2, Download } from 'lucide-react';
import AppShell from '../../components/layout/AppShell';
import Button from '../../components/ui/Button';
import Modal from '../../components/ui/Modal';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import Legend from '../../components/ui/Legend';
import { useRBAC } from '../../hooks/useRBAC';
import { useSessionState, hasSessionState } from '../../hooks/useSessionState';
import { formatDateTime } from '../../utils/formatters';
import { getDefaults, getRequirements, getVendorCounts, markOrdered, listBatches, undoBatch } from '../../api/procurement.api';
import { listVendors } from '../../api/vendors.api';

const isoLocal = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};
const todayISO = () => isoLocal(new Date());

const EMPTY = { pos: [], raw_products: [], po_count: 0, unmapped_line_count: 0, unmapped_samples: [] };

const ORDERED_LEGEND = [{ swatch: 'bg-green-100', label: 'Already marked as ordered' }];

export default function ProcurementPage() {
  const { canEdit } = useRBAC();

  const [data, setData] = useState(EMPTY);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useSessionState('procurement.filters', { po_date_from: '', po_date_to: '' });
  // Whether this tab already has a persisted range — gates the first-visit
  // getDefaults() seeding so it doesn't clobber a restored date range.
  const seeded = useRef(hasSessionState('procurement.filters'));

  // Master ("All") tab plus one tab per active vendor. The active tab narrows the
  // whole matrix (and the mark-ordered action) to that vendor; "All" shows every vendor.
  const ALL_TAB = { key: 'All', label: 'All' };
  const [vendorTabs, setVendorTabs] = useState([ALL_TAB]);
  const [vendorTab, setVendorTab] = useSessionState('procurement.vendorTab', 'All');
  const [vendorCounts, setVendorCounts] = useState({}); // not-ordered PO count per vendor tab
  const [confirmMark, setConfirmMark] = useState(false);
  const [marking, setMarking] = useState(false);
  const [selected, setSelected] = useState(new Set()); // po_ids checked for marking

  const [historyOpen, setHistoryOpen] = useState(false);
  const [batches, setBatches] = useState([]);
  const [batchesLoading, setBatchesLoading] = useState(false);
  const [undoingId, setUndoingId] = useState(null);

  const load = useCallback((f, vendor) => {
    setLoading(true);
    const params = {};
    if (f.po_date_from) params.po_date_from = f.po_date_from;
    if (f.po_date_to) params.po_date_to = f.po_date_to;
    if (vendor && vendor !== 'All') params.vendor = vendor;
    return getRequirements(params)
      .then((d) => {
        setData(d);
        // Fresh POs/scope — drop any prior selection so we never mark stale ids.
        setSelected(new Set());
      })
      .catch(() => toast.error('Failed to load procurement requirements'))
      .finally(() => setLoading(false));
  }, []);

  // Vendor tabs: "All" master plus one per active vendor.
  useEffect(() => {
    listVendors()
      .then(rows => setVendorTabs([ALL_TAB, ...rows.filter(v => v.is_active).map(v => ({ key: v.name, label: v.name }))]))
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Per-vendor tab badges: not-yet-ordered PO counts for the current date range.
  const loadCounts = useCallback((f) => {
    const params = {};
    if (f.po_date_from) params.po_date_from = f.po_date_from;
    if (f.po_date_to) params.po_date_to = f.po_date_to;
    return getVendorCounts(params)
      .then(res => setVendorCounts(res.counts || {}))
      .catch(() => {});
  }, []);

  // On mount: reuse the session-restored range/tab if this tab already has one;
  // otherwise seed From from the server default (day after last ordered, else
  // earliest), To = today.
  useEffect(() => {
    if (seeded.current) {
      loadCounts(filters);
      load(filters, vendorTab);
      return;
    }
    getDefaults()
      .then(d => {
        const f = { po_date_from: d.po_date_from || '', po_date_to: todayISO() };
        setFilters(f);
        loadCounts(f);
        return load(f, 'All');
      })
      .catch(() => { const f = { po_date_from: '', po_date_to: todayISO() }; setFilters(f); loadCounts(f); load(f, 'All'); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, loadCounts]);

  const notOrderedPos = data.pos.filter(p => !p.ordered);
  const allSelected = notOrderedPos.length > 0 && notOrderedPos.every(p => selected.has(p.po_id));
  const toggleSelectAll = () =>
    setSelected(allSelected ? new Set() : new Set(notOrderedPos.map(p => p.po_id)));
  const toggleSelect = (poId) =>
    setSelected(prev => { const n = new Set(prev); n.has(poId) ? n.delete(poId) : n.add(poId); return n; });

  const applyFilters = () => { load(filters, vendorTab); loadCounts(filters); };
  const clearFilters = () => { const f = { po_date_from: '', po_date_to: '' }; setFilters(f); load(f, vendorTab); loadCounts(f); };
  const switchTab = (key) => { setVendorTab(key); load(filters, key); };

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
        po_ids: [...selected],
        po_date_from: filters.po_date_from || undefined,
        po_date_to: filters.po_date_to || undefined,
        vendor: vendorTab !== 'All' ? vendorTab : undefined,
      });
      toast.success(`Marked ${r.po_count} PO${r.po_count !== 1 ? 's' : ''} as ordered`);
      setConfirmMark(false);
      load(filters, vendorTab);
      loadCounts(filters);
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
      load(filters, vendorTab);
      loadCounts(filters);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Undo failed');
    } finally { setUndoingId(null); }
  };

  const exportXLSX = () => {
    const { pos, raw_products } = data;
    if (!raw_products.length) { toast('Nothing to export'); return; }
    const header = ['Raw Product', 'Total Required', ...pos.map(p => `${p.po_id} · ${p.po_date || '—'} · ${p.vendor}${p.ordered ? ' (ordered)' : ''}`)];
    const body = raw_products.map(r => [
      r.name,
      r.total_required_qty,
      ...pos.map(p => r.quantities[p.po_id] || 0),
    ]);
    const ws = XLSX.utils.aoa_to_sheet([header, ...body]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Procurement');
    const from = filters.po_date_from || 'all';
    const to = filters.po_date_to || 'all';
    const scope = vendorTab === 'All' ? 'all-vendors' : vendorTab.toLowerCase();
    XLSX.writeFile(wb, `procurement-${scope}-${from}_${to}.xlsx`);
  };

  const inputCls = 'w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f]';
  const { pos, raw_products } = data;

  // Sticky column classes: Raw Product frozen at left:0, Total at left:14rem.
  // Freeze only from md+ — on phones the two frozen columns (14rem + 9rem)
  // would be wider than the viewport, so let them scroll normally instead.
  // The min-widths MUST match the offsets (14rem name + 9rem total) so the
  // frozen columns fully cover their slot — otherwise the Raw Product column
  // shrinks below 14rem and the scrolled PO columns peek through the gap.
  const stickyName = 'md:sticky md:left-0 z-10 bg-white w-56 min-w-[14rem] max-w-[14rem]';
  const stickyTotal = 'md:sticky md:left-56 z-10 bg-white w-36 min-w-[9rem] max-w-[9rem]';
  const stickyNameHead = 'md:sticky md:left-0 z-20 bg-gray-50 w-56 min-w-[14rem] max-w-[14rem]';
  const stickyTotalHead = 'md:sticky md:left-56 z-20 bg-gray-50 w-36 min-w-[9rem] max-w-[9rem]';

  return (
    <AppShell>
      <div className="flex items-start justify-between mb-4 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#003049]">Procurement Status</h1>
          <p className="text-gray-500 text-sm">Raw materials required per PO. Total counts only POs you haven&apos;t ordered for yet.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={exportXLSX} disabled={loading || raw_products.length === 0}><Download size={16} />Export</Button>
          <Button variant="outline" onClick={openHistory}><History size={16} />Ordered history</Button>
        </div>
      </div>

      {/* Vendor tabs: All (master) + one per vendor */}
      <div className="flex gap-1 mb-4 border-b border-gray-200 overflow-x-auto">
        {vendorTabs.map(t => (
          <button
            key={t.key}
            type="button"
            onClick={() => switchTab(t.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap ${
              vendorTab === t.key
                ? 'border-[#c1121f] text-[#c1121f]'
                : 'border-transparent text-gray-500 hover:text-[#003049]'
            }`}
          >
            {t.label} <span className="ml-1 text-gray-400">({vendorCounts[t.key] ?? 0})</span>
          </button>
        ))}
      </div>

      {/* Filters */}
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
              <Button onClick={() => setConfirmMark(true)} disabled={loading || selected.size === 0}>
                <CheckCircle2 size={16} />Mark as ordered
              </Button>
            )}
          </div>
        </div>
        <div className="mt-3 pt-3 border-t border-gray-100 text-sm text-gray-600">
          <span className="font-semibold text-[#003049]">{pos.length}</span> PO{pos.length !== 1 ? 's' : ''} in range
          <span className="text-gray-400"> · </span>
          <span className="font-semibold text-[#003049]">{data.po_count}</span> still to order
          <span className="text-gray-400"> · </span>
          <span className="font-semibold text-[#003049]">{selected.size}</span> selected
        </div>
      </div>

      {/* Unmapped warning */}
      {data.unmapped_line_count > 0 && (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <div>
            <span className="font-medium">{data.unmapped_line_count} PO line{data.unmapped_line_count !== 1 ? 's' : ''}</span> couldn&apos;t be matched to a SKU with requirements and {data.unmapped_line_count !== 1 ? 'are' : 'is'} not counted below. Add the missing vendor mapping or SKU requirements.
            {data.unmapped_samples?.length > 0 && (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs font-medium text-amber-800 hover:underline">Show details</summary>
                <div className="mt-2 overflow-x-auto scrollbar-thin rounded-lg border border-amber-200 bg-white">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-amber-100/60 text-amber-900">
                        <th className="px-2 py-1.5 text-left font-semibold">Vendor</th>
                        <th className="px-2 py-1.5 text-left font-semibold">Item Code/EAN</th>
                        <th className="px-2 py-1.5 text-left font-semibold">PO ID</th>
                        <th className="px-2 py-1.5 text-left font-semibold">Vendor PO No</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.unmapped_samples.map((s, i) => (
                        <tr key={i} className="border-t border-amber-100">
                          <td className="px-2 py-1.5 text-gray-700">{s.vendor}</td>
                          <td className="px-2 py-1.5 font-mono text-gray-800">{s.item_code}</td>
                          <td className="px-2 py-1.5">
                            <Link to={`/purchase-orders/${s.po_id}`} className="font-mono font-semibold text-[#c1121f] hover:underline">{s.po_id}</Link>
                          </td>
                          <td className="px-2 py-1.5 font-mono text-gray-600">{s.vendor_po_id || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {data.unmapped_samples.length >= 50 && (
                  <p className="mt-1 text-xs text-amber-700">Showing the first 50 unmatched lines — narrow the date range to see the rest.</p>
                )}
              </details>
            )}
          </div>
        </div>
      )}

      {pos.some(p => p.ordered) && <Legend items={ORDERED_LEGEND} className="mb-2" />}

      {/* Matrix */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-auto max-h-[70vh]">
          <table className="text-sm border-separate border-spacing-0">
            <thead>
              {/* Select-row: one checkbox aligned over each PO column; Mark as ordered acts on the checked POs. */}
              {canEdit && (
                <tr className="bg-gray-50">
                  <th className={`${stickyNameHead} px-4 py-2 text-left font-medium text-gray-600 border-b border-r border-gray-200 w-56`}>
                    <label className="inline-flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={allSelected}
                        onChange={toggleSelectAll}
                        disabled={notOrderedPos.length === 0}
                        className="accent-[#c1121f]"
                      />
                      <span className="text-xs">Select all</span>
                    </label>
                  </th>
                  <th className={`${stickyTotalHead} px-4 py-2 border-b border-r border-gray-200 w-36`} />
                  {pos.map(p => (
                    <th
                      key={p.po_id}
                      className={`px-3 py-2 text-center border-b border-gray-200 ${p.ordered ? 'bg-green-100' : ''}`}
                    >
                      {!p.ordered && (
                        <input
                          type="checkbox"
                          checked={selected.has(p.po_id)}
                          onChange={() => toggleSelect(p.po_id)}
                          title={`Select ${p.po_id}`}
                          className="accent-[#c1121f]"
                        />
                      )}
                    </th>
                  ))}
                </tr>
              )}
              <tr className="bg-gray-50">
                <th className={`${stickyNameHead} px-4 py-3 text-left font-semibold text-gray-600 border-b border-r border-gray-200 w-56`}>Raw Product</th>
                <th className={`${stickyTotalHead} px-4 py-3 text-left font-semibold text-gray-600 border-b border-r border-gray-200 w-36`}>Total Required</th>
                {pos.map(p => (
                  <th
                    key={p.po_id}
                    className={`px-3 py-2 text-left font-semibold border-b border-gray-200 whitespace-nowrap ${p.ordered ? 'bg-green-100 text-green-800' : 'text-gray-600'}`}
                  >
                    <div className="font-mono">{p.po_id}</div>
                    <div className="text-[11px] font-normal opacity-70">{p.po_date || '—'} · {p.vendor}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                [...Array(5)].map((_, i) => (
                  <tr key={i}><td colSpan={2 + pos.length} className="px-4 py-3"><div className="h-4 bg-gray-100 rounded animate-pulse" /></td></tr>
                ))
              ) : raw_products.map(r => (
                <tr key={r.raw_product_id} className="hover:bg-gray-50">
                  <td className={`${stickyName} px-4 py-2.5 font-medium text-gray-900 border-b border-r border-gray-100`}>{r.name}</td>
                  <td className={`${stickyTotal} px-4 py-2.5 font-semibold text-gray-800 border-b border-r border-gray-100`}>{Number(r.total_required_qty).toLocaleString('en-IN')}</td>
                  {pos.map(p => {
                    const q = r.quantities[p.po_id] || 0;
                    return (
                      <td key={p.po_id} className={`px-3 py-2.5 border-b border-gray-100 ${p.ordered ? 'bg-green-50/60' : ''} ${q ? 'text-gray-800' : 'text-gray-300'}`}>
                        {Number(q).toLocaleString('en-IN')}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && raw_products.length === 0 && (
            <p className="text-center text-gray-400 py-8">No raw products yet — add them on the SKU Products → Raw Products tab.</p>
          )}
          {!loading && raw_products.length > 0 && pos.length === 0 && (
            <p className="text-center text-gray-400 py-8">No POs in the selected date range.</p>
          )}
        </div>
      </div>

      <ConfirmDialog
        isOpen={confirmMark}
        onClose={() => setConfirmMark(false)}
        onConfirm={doMark}
        title="Mark POs as ordered"
        message={`Mark ${selected.size} selected PO${selected.size !== 1 ? 's' : ''} as raw-ordered? They'll drop out of the Total (and the default view next time). You can undo this from Ordered history.`}
        confirmLabel="Mark as ordered"
        loading={marking}
      />

      <Modal isOpen={historyOpen} onClose={() => setHistoryOpen(false)} title="Ordered history" size="lg">
        {batchesLoading ? (
          <div className="space-y-2">{[...Array(3)].map((_, i) => <div key={i} className="h-10 bg-gray-100 rounded animate-pulse" />)}</div>
        ) : batches.length === 0 ? (
          <p className="text-center text-gray-400 py-6">No batches marked as ordered yet.</p>
        ) : (
          <div className="overflow-x-auto scrollbar-thin">
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
