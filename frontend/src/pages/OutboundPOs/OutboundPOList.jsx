import { useEffect, useState, useCallback, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import * as XLSX from 'xlsx';
import { Plus, Pencil, Trash2, RotateCcw, FileText, Download, Save, ArrowUp, ArrowDown, ArrowUpDown, ChevronDown } from 'lucide-react';
import toast from 'react-hot-toast';
import AppShell from '../../components/layout/AppShell';
import Button from '../../components/ui/Button';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import Badge from '../../components/ui/Badge';
import Pagination, { loadPersistedPageSize, persistPageSize } from '../../components/ui/Pagination';
import { useSessionState } from '../../hooks/useSessionState';
import { listOutboundPOs, deleteOutboundPO, restoreOutboundPO, updateOutboundPO } from '../../api/outboundPOs.api';
import { listOutboundVendors } from '../../api/outboundVendors.api';
import { listUsersLite } from '../../api/users.api';
import { ROLES } from '../../utils/roles';
import { formatDateTime } from '../../utils/formatters';

// One row per PO line, matching the on-screen sub-rows. `columns` is
// [{ key, header }]; values come straight off the flattened row.
function downloadRows(filename, columns, rows) {
  const header = columns.map(c => c.header);
  const data = rows.map(r => columns.map(c => (r[c.key] == null ? '' : r[c.key])));
  const ws = XLSX.utils.aoa_to_sheet([header, ...data]);
  ws['!cols'] = header.map(() => ({ wch: 20 }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Export');
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
  XLSX.writeFile(wb, `${filename}-${stamp}.xlsx`);
}

const STATUS_COLORS = { Open: 'blue', 'Partially Received': 'yellow', Closed: 'green', Deleted: 'gray' };

const STATUS_MULTI_OPTIONS = ['Open', 'Partially Received', 'Closed'];

const defaultFilters = () => ({
  order_no: '', vendor_id: '', status: ['Open', 'Partially Received'], show_deleted: false,
  po_date_from: '', po_date_to: '',
});

// Checkbox dropdown for the Status filter — mirrors GRNList's StatusMultiSelect.
function StatusMultiSelect({ selected, onChange, disabled }) {
  const detRef = useRef(null);
  useEffect(() => {
    const handler = (e) => {
      if (detRef.current?.open && !detRef.current.contains(e.target)) detRef.current.open = false;
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);
  const toggle = (s) => {
    onChange(selected.includes(s) ? selected.filter(x => x !== s) : [...selected, s]);
  };
  const label = (selected.length === 0 || selected.length === STATUS_MULTI_OPTIONS.length)
    ? 'All statuses'
    : `${selected.length} selected`;
  return (
    <details ref={detRef} className={`relative ${disabled ? 'pointer-events-none opacity-50' : ''}`}>
      <summary className="list-none cursor-pointer flex items-center justify-between w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30">
        <span className="text-gray-700 truncate">{label}</span>
        <ChevronDown size={14} className="text-gray-400 shrink-0" />
      </summary>
      <div className="absolute z-20 mt-1 w-60 bg-white border border-gray-200 rounded-lg shadow-lg p-1 max-h-64 overflow-auto">
        {STATUS_MULTI_OPTIONS.map(s => (
          <label key={s} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-gray-50 cursor-pointer text-sm">
            <input type="checkbox" checked={selected.includes(s)} onChange={() => toggle(s)} />
            <span className="text-gray-700">{s}</span>
          </label>
        ))}
      </div>
    </details>
  );
}

// Vendor-level columns rendered once per PO (rowSpan across its line rows),
// split around the Article sub-column group.
const LEFT_COLUMNS = [
  { key: 'id', label: 'Order No' },
  { key: 'vendor_name', label: 'Vendor' },
  { key: 'status', label: 'Status' },
];
const RIGHT_COLUMNS = [
  { key: 'po_date', label: 'Order Date' },
  { key: 'approved_by_name', label: 'Approved By' },
  { key: 'updated_at', label: 'Last Updated' },
];
// One real <td> per line row — no more chip+text blob. Order info first
// (Qty, Rate), then fulfillment tracking (Received, Short), then the
// number derived from those two (Pending) last.
const ARTICLE_COLUMNS = ['Category', 'Item Name', 'Variant', 'Qty', 'Rate', 'Received', 'Short', 'Pending'];
const TABLE_COL_COUNT = LEFT_COLUMNS.length + ARTICLE_COLUMNS.length + RIGHT_COLUMNS.length + 1; // + Actions

const EXPORT_COLUMNS = [
  { key: 'order_no', header: 'order_no' },
  { key: 'vendor_name', header: 'vendor' },
  { key: 'company_name', header: 'company' },
  { key: 'status', header: 'status' },
  { key: 'approved_by_name', header: 'approved_by' },
  { key: 'po_date', header: 'order_date' },
  { key: 'category', header: 'category' },
  { key: 'item_name', header: 'item_name' },
  { key: 'variant', header: 'variant' },
  { key: 'qty', header: 'qty' },
  { key: 'rate', header: 'rate' },
  { key: 'received', header: 'received' },
  { key: 'short', header: 'short' },
  { key: 'pending', header: 'pending' },
  { key: 'updated_by_name', header: 'last_updated_by' },
  { key: 'updated_at', header: 'last_updated_at' },
];

const pending = (l) => Math.max(0, l.qty - l.received - l.short);

// If a PO's current approver isn't in the live Purchase_Head list (tagged
// before the role existed, or since untagged), keep them selectable so the
// dropdown doesn't silently show "Not yet approved" over a real value.
function approverOptionsFor(po, approvers) {
  const opts = approvers.map(u => ({ value: u.id, label: u.name }));
  if (po.approved_by && !opts.some(o => o.value === po.approved_by)) {
    opts.push({ value: po.approved_by, label: `${po.approved_by_name || 'Unknown'} (not Purchase Head)` });
  }
  return opts;
}

export default function OutboundPOList() {
  const navigate = useNavigate();
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useSessionState('outboundPOs.filters', defaultFilters);
  const [sort, setSort] = useSessionState('outboundPOs.sort', { key: 'updated_at', dir: 'desc' });
  const [page, setPage] = useSessionState('outboundPOs.page', 1);
  const [pageSize, setPageSize] = useState(() => loadPersistedPageSize('outboundPOs', 25));
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState(null);
  const [restoring, setRestoring] = useState(false);
  const [vendors, setVendors] = useState([]);
  const [approvers, setApprovers] = useState([]);
  const [downloading, setDownloading] = useState(false);
  const [savingIds, setSavingIds] = useState(() => new Set());
  const [dirtyIds, setDirtyIds] = useState(() => new Set());

  const handleDownload = async () => {
    setDownloading(true);
    try {
      // Export everything matching the current filters, not just this page.
      const res = await listOutboundPOs({ ...buildParams(), page: 1, page_size: 'all' });
      const exportRows = (res.rows || []).flatMap(po => {
        const base = {
          order_no: po.order_no, vendor_name: po.vendor_name, company_name: po.company_name || '',
          status: po.status, approved_by_name: po.approved_by_name || '', po_date: po.po_date || '',
          updated_by_name: po.updated_by_name || '', updated_at: po.updated_at,
        };
        if (!po.lines.length) return [{ ...base, category: '', item_name: '', variant: '', qty: '', rate: '', received: '', pending: '', short: '' }];
        return po.lines.map(l => ({
          ...base,
          category: l.category, item_name: l.item_name, variant: l.variant || '',
          qty: l.qty, rate: l.rate, received: l.received, pending: pending(l), short: l.short,
        }));
      });
      downloadRows('outbound-purchase-orders', EXPORT_COLUMNS, exportRows);
    } catch {
      toast.error('Failed to export');
    } finally { setDownloading(false); }
  };

  useEffect(() => {
    listOutboundVendors()
      .then(rows => setVendors(rows.filter(v => v.is_active)))
      .catch(() => {});
    listUsersLite({ role: ROLES.PURCHASE_HEAD }).then(setApprovers).catch(() => {});
  }, []);

  // Inline editing: qty/rate/received/short and Approved By can all be
  // edited directly in the table, no need to open the PO. Nothing saves as
  // you type — edits just mark the row dirty; a Save icon appears in
  // Actions and commits every staged change for that row (Approved By +
  // all lines) together in one request. A full `lines` array is always
  // sent since the backend does a delete-and-reinsert (same as the
  // detail-page save).
  const markDirty = (poId) => setDirtyIds(prev => new Set(prev).add(poId));

  const setLineField = (poId, lineIdx, field, value) => {
    setItems(prev => prev.map(po => po.id !== poId ? po : {
      ...po,
      lines: po.lines.map((l, i) => i !== lineIdx ? l : { ...l, [field]: value }),
    }));
    markDirty(poId);
  };

  const setApprovedByField = (poId, value) => {
    setItems(prev => prev.map(po => po.id !== poId ? po : { ...po, approved_by: value ? Number(value) : null }));
    markDirty(poId);
  };

  const saveRow = async (po) => {
    setSavingIds(s => new Set(s).add(po.id));
    try {
      const res = await updateOutboundPO(po.id, {
        approved_by: po.approved_by || null,
        lines: po.lines.map(l => ({
          line_no: l.line_no, category: l.category, item_name: l.item_name, variant: l.variant || null,
          qty: Number(l.qty), rate: Number(l.rate), received: Number(l.received) || 0, short: Number(l.short) || 0,
        })),
      });
      setItems(prev => prev.map(p => p.id === po.id ? { ...p, ...res } : p));
      setDirtyIds(prev => { const n = new Set(prev); n.delete(po.id); return n; });
      toast.success(`PO ${po.order_no} updated`);
    } catch (err) {
      // Keep the edits in place (don't revert) so the user can fix and retry —
      // e.g. this fires when Approved By hasn't been set yet.
      toast.error(err.response?.data?.message || 'Save failed');
    } finally {
      setSavingIds(s => { const n = new Set(s); n.delete(po.id); return n; });
    }
  };

  const buildParams = useCallback((overrides) => {
    const f = overrides?.filters ?? filters;
    const s = overrides?.sort ?? sort;
    const p = overrides?.page ?? page;
    const ps = overrides?.pageSize ?? pageSize;
    const params = { page: p, page_size: ps, sort_by: s.key, sort_dir: s.dir };
    if (f.order_no) params.order_no = f.order_no;
    if (f.vendor_id) params.vendor_id = f.vendor_id;
    if (f.po_date_from) params.po_date_from = f.po_date_from;
    if (f.po_date_to) params.po_date_to = f.po_date_to;
    if (f.show_deleted) {
      params.status = 'Deleted';
    } else if (Array.isArray(f.status) && f.status.length) {
      params.status = f.status.join(',');
    }
    return params;
  }, [filters, sort, page, pageSize]);

  const load = useCallback((overrides) => {
    setLoading(true);
    listOutboundPOs(buildParams(overrides))
      .then(res => { setItems(res.rows || []); setTotal(res.total || 0); })
      .catch(() => toast.error('Failed to load outbound POs'))
      .finally(() => setLoading(false));
  }, [buildParams]);

  useEffect(() => {
    load({ filters, page });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setFilter = (k, v) => setFilters(f => ({ ...f, [k]: v }));
  const onSearchKey = (e) => { if (e.key === 'Enter') applySearch(); };
  const applySearch = () => { setPage(1); load({ page: 1 }); };
  const clearFilters = () => { const f = defaultFilters(); setFilters(f); setPage(1); load({ filters: f, page: 1 }); };

  const toggleSort = (key) => {
    if (!key) return;
    setSort(s => {
      const next = s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' };
      setPage(1);
      load({ sort: next, page: 1 });
      return next;
    });
  };

  const handlePageChange = (p) => { setPage(p); load({ page: p }); };
  const handlePageSizeChange = (size) => {
    setPageSize(size);
    persistPageSize('outboundPOs', size);
    setPage(1);
    load({ pageSize: size, page: 1 });
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await deleteOutboundPO(confirmDelete.id);
      toast.success(`Deleted PO ${confirmDelete.order_no}`);
      setConfirmDelete(null);
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Delete failed');
    } finally { setDeleting(false); }
  };

  const handleRestore = async () => {
    setRestoring(true);
    try {
      await restoreOutboundPO(confirmRestore.id);
      toast.success(`Restored PO ${confirmRestore.order_no}`);
      setConfirmRestore(null);
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Restore failed');
    } finally { setRestoring(false); }
  };

  const inputCls = 'w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30';
  const cellCls = 'w-16 px-1.5 py-1 border border-gray-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-[#c1121f]/40 focus:border-[#c1121f] disabled:bg-gray-50 disabled:text-gray-400 disabled:border-transparent';

  const SortIcon = ({ colKey }) => {
    if (sort.key !== colKey) return <ArrowUpDown size={12} className="text-gray-300" />;
    return sort.dir === 'asc' ? <ArrowUp size={12} className="text-[#c1121f]" /> : <ArrowDown size={12} className="text-[#c1121f]" />;
  };

  return (
    <AppShell>
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#003049]">Outbound Purchase Orders</h1>
          <p className="text-gray-500 text-sm">{total} outbound PO{total !== 1 ? 's' : ''}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={handleDownload} loading={downloading}><Download size={16} />Download XLSX</Button>
          <Button onClick={() => navigate('/outbound/purchase-orders/new')}><Plus size={16} />Add PO</Button>
        </div>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl p-4 mb-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Status</label>
            <StatusMultiSelect selected={filters.status} onChange={v => setFilter('status', v)} disabled={filters.show_deleted} />
          </div>
          <div className="flex items-end pb-2">
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={filters.show_deleted} onChange={e => setFilter('show_deleted', e.target.checked)} />
              Show deleted
            </label>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Order No</label>
            <input value={filters.order_no} onChange={e => setFilter('order_no', e.target.value)} onKeyDown={onSearchKey} placeholder="e.g. 001" className={inputCls} />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Vendor</label>
            <select value={filters.vendor_id} onChange={e => setFilter('vendor_id', e.target.value)} className={inputCls}>
              <option value="">All vendors</option>
              {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Order Date From</label>
            <input type="date" value={filters.po_date_from} onChange={e => setFilter('po_date_from', e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Order Date To</label>
            <input type="date" value={filters.po_date_to} onChange={e => setFilter('po_date_to', e.target.value)} className={inputCls} />
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-3">
          <Button variant="ghost" onClick={clearFilters}>Clear</Button>
          <Button variant="outline" onClick={applySearch}>Search</Button>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto scrollbar-thin">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-gray-50">
              <tr>
                {LEFT_COLUMNS.map(col => (
                  <th key={col.key} rowSpan={2} className="px-4 py-3 text-left font-semibold text-gray-600 whitespace-nowrap bg-gray-50 align-middle border-b border-gray-200">
                    <button type="button" onClick={() => toggleSort(col.key)} className="inline-flex items-center gap-1 hover:text-[#003049]">
                      {col.label}<SortIcon colKey={col.key} />
                    </button>
                  </th>
                ))}
                <th colSpan={ARTICLE_COLUMNS.length} className="px-4 py-1.5 text-center font-semibold text-gray-600 whitespace-nowrap bg-gray-50 border-b border-gray-100">
                  Article
                </th>
                {RIGHT_COLUMNS.map(col => (
                  <th key={col.key} rowSpan={2} className="px-4 py-3 text-left font-semibold text-gray-600 whitespace-nowrap bg-gray-50 align-middle border-b border-gray-200">
                    <button type="button" onClick={() => toggleSort(col.key)} className="inline-flex items-center gap-1 hover:text-[#003049]">
                      {col.label}<SortIcon colKey={col.key} />
                    </button>
                  </th>
                ))}
                <th rowSpan={2} className="px-4 py-3 text-left font-semibold text-gray-600 whitespace-nowrap bg-gray-50 align-middle border-b border-gray-200">Actions</th>
              </tr>
              <tr>
                {ARTICLE_COLUMNS.map(c => (
                  <th key={c} className="px-3 py-2 text-left font-medium text-gray-500 whitespace-nowrap bg-gray-50 text-xs border-b border-gray-200">{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                [...Array(4)].map((_, i) => (
                  <tr key={i}><td colSpan={TABLE_COL_COUNT} className="px-4 py-3"><div className="h-4 bg-gray-100 rounded animate-pulse" /></td></tr>
                ))
              ) : items.flatMap(po => {
                const lines = po.lines.length ? po.lines : [null];
                return lines.map((l, idx) => (
                  <tr
                    key={`${po.id}-${idx}`}
                    className={`hover:bg-gray-50 transition-colors ${idx === lines.length - 1 ? 'border-b-2 border-gray-200' : 'border-b border-gray-50'}`}
                  >
                    {idx === 0 && (
                      <>
                        <td rowSpan={lines.length} className="px-4 py-3 font-mono font-semibold text-[#003049] align-middle">
                          <Link to={`/outbound/purchase-orders/${po.id}`} className="flex items-center gap-2 hover:underline">
                            <FileText size={14} className="text-gray-400 shrink-0" />{po.order_no}
                          </Link>
                        </td>
                        <td rowSpan={lines.length} className="px-4 py-3 whitespace-nowrap align-middle">{po.vendor_name}</td>
                        <td rowSpan={lines.length} className="px-4 py-3 align-middle"><Badge color={STATUS_COLORS[po.status] || 'gray'}>{po.status}</Badge></td>
                      </>
                    )}
                    {l ? (
                      <>
                        <td className="px-3 py-2 text-gray-700 whitespace-nowrap">{l.category}</td>
                        <td className="px-3 py-2 text-gray-700 whitespace-nowrap">{l.item_name}</td>
                        <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{l.variant || '—'}</td>
                        <td className="px-3 py-2">
                          <input
                            type="number" min={1} value={l.qty} disabled={po.status === 'Deleted'}
                            onChange={e => setLineField(po.id, idx, 'qty', e.target.value)}
                            className={cellCls}
                          />
                        </td>
                        <td className="px-3 py-2">
                          <input
                            type="number" min={0} step="0.01" value={l.rate} disabled={po.status === 'Deleted'}
                            onChange={e => setLineField(po.id, idx, 'rate', e.target.value)}
                            className={cellCls}
                          />
                        </td>
                        <td className="px-3 py-2">
                          <input
                            type="number" min={0} value={l.received} disabled={po.status === 'Deleted'}
                            onChange={e => setLineField(po.id, idx, 'received', e.target.value)}
                            className={cellCls}
                          />
                        </td>
                        <td className="px-3 py-2">
                          <input
                            type="number" min={0} value={l.short} disabled={po.status === 'Deleted'}
                            onChange={e => setLineField(po.id, idx, 'short', e.target.value)}
                            className={cellCls}
                          />
                        </td>
                        <td className={`px-3 py-2 font-medium ${pending(l) > 0 ? 'text-amber-700' : 'text-gray-800'}`}>{pending(l)}</td>
                      </>
                    ) : (
                      <td colSpan={ARTICLE_COLUMNS.length} className="px-3 py-2 text-xs text-gray-400">—</td>
                    )}
                    {idx === 0 && (
                      <>
                        <td rowSpan={lines.length} className="px-4 py-3 text-gray-600 whitespace-nowrap align-middle">{po.po_date || '—'}</td>
                        <td rowSpan={lines.length} className="px-4 py-3 align-middle">
                          <select
                            value={po.approved_by || ''}
                            disabled={po.status === 'Deleted' || savingIds.has(po.id)}
                            onChange={e => setApprovedByField(po.id, e.target.value)}
                            className={`${inputCls} py-1.5`}
                          >
                            <option value="">Not yet approved</option>
                            {approverOptionsFor(po, approvers).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                        </td>
                        <td rowSpan={lines.length} className="px-4 py-3 whitespace-nowrap align-middle">
                          <div className="text-gray-700">{po.updated_by_name || '—'}</div>
                          <div className="text-xs text-gray-400">{formatDateTime(po.updated_at)}</div>
                        </td>
                        <td rowSpan={lines.length} className="px-4 py-3 align-middle">
                          <div className="flex items-center gap-1">
                            {dirtyIds.has(po.id) && (
                              <button
                                onClick={() => saveRow(po)}
                                disabled={savingIds.has(po.id)}
                                title="Save changes"
                                className="p-1.5 rounded hover:bg-green-50 text-green-600 disabled:opacity-40"
                              >
                                <Save size={14} />
                              </button>
                            )}
                            <Link to={`/outbound/purchase-orders/${po.id}`} title="View/Edit" className="p-1.5 rounded hover:bg-blue-50 text-blue-500"><Pencil size={14} /></Link>
                            {po.status === 'Deleted' ? (
                              <button onClick={() => setConfirmRestore(po)} title="Restore" className="p-1.5 rounded hover:bg-green-50 text-green-600"><RotateCcw size={14} /></button>
                            ) : (
                              <button onClick={() => setConfirmDelete(po)} title="Delete" className="p-1.5 rounded hover:bg-red-50 text-red-500"><Trash2 size={14} /></button>
                            )}
                          </div>
                        </td>
                      </>
                    )}
                  </tr>
                ));
              })}
            </tbody>
          </table>
          {!loading && items.length === 0 && (
            <p className="text-center text-gray-400 py-8">No outbound POs match the current filters</p>
          )}
        </div>
        <Pagination
          page={page}
          pageSize={pageSize}
          total={total}
          onPageChange={handlePageChange}
          onPageSizeChange={handlePageSizeChange}
        />
      </div>

      <ConfirmDialog
        isOpen={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        onConfirm={handleDelete}
        title="Delete Outbound PO"
        message={`Delete PO ${confirmDelete?.order_no} (${confirmDelete?.vendor_name})? It will be hidden from the list but can be restored from the Deleted filter.`}
        confirmLabel="Delete"
        loading={deleting}
      />

      <ConfirmDialog
        isOpen={!!confirmRestore}
        onClose={() => setConfirmRestore(null)}
        onConfirm={handleRestore}
        title="Restore Outbound PO"
        message={`Restore PO ${confirmRestore?.order_no} (${confirmRestore?.vendor_name})?`}
        confirmLabel="Restore"
        loading={restoring}
      />
    </AppShell>
  );
}
