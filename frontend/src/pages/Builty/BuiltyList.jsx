import { useEffect, useState, useCallback } from 'react';
import * as XLSX from 'xlsx';
import { ArrowUp, ArrowDown, ArrowUpDown, Download, Save, X } from 'lucide-react';
import toast from 'react-hot-toast';
import AppShell from '../../components/layout/AppShell';
import Button from '../../components/ui/Button';
import Modal from '../../components/ui/Modal';
import Pagination, { loadPersistedPageSize, persistPageSize } from '../../components/ui/Pagination';
import { listOrderSummary, updateOrderSummary } from '../../api/orderSummary.api';
import { listCities } from '../../api/cities.api';
import { formatDateTime } from '../../utils/formatters';
import { useRBAC } from '../../hooks/useRBAC';

const VENDOR_TABS = [
  { key: 'Blinkit', label: 'Blinkit' },
  { key: 'Scootsy', label: 'Scootsy' },
  { key: 'Zepto',   label: 'Zepto' },
];

const defaultFilters = () => ({
  po_id: '', city: '',
  po_date_from: '', po_date_to: '',
  dispatch_date_from: '', dispatch_date_to: '',
  status: 'All', tracking_id: '', bill_no: '',
});

const COLUMNS = [
  { key: 'po_id',          label: 'PO ID' },
  { key: 'po_date',        label: 'Order Date' },
  { key: 'vendor',         label: 'Vendor' },
  { key: 'party_name',     label: 'Party Name' },
  { key: 'vendor_po_id',   label: 'PO No.' },
  { key: 'total_qty',      label: 'Quantity' },
  { key: 'city',           label: 'City' },
  { key: 'dispatch_date',  label: 'Dispatch Date' },
  { key: 'courier_name',   label: 'Courier' },
  { key: 'tracking_id',    label: 'Tracking ID' },
  { key: 'bill_no',        label: 'Bill no' },
  { key: 'updated_at',     label: 'Last Updated' },
];

export default function BuiltyList() {
  const { canAccess } = useRBAC();
  const canEdit = canAccess('Admin', 'Owner', 'Office_POC', 'PO_Executive');

  const [vendorTab, setVendorTab] = useState('Blinkit');
  const [filters, setFilters] = useState(defaultFilters);
  const [sort, setSort] = useState({ key: 'updated_at', dir: 'desc' });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(() => loadPersistedPageSize('builty', 25));

  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const [cities, setCities] = useState([]);
  const [edits, setEdits] = useState({});
  const [savingId, setSavingId] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [conflict, setConflict] = useState(null);

  const buildParams = useCallback((overrides = {}) => {
    const f = overrides.filters ?? filters;
    const v = overrides.vendor ?? vendorTab;
    const s = overrides.sort ?? sort;
    const p = overrides.page ?? page;
    const ps = overrides.pageSize ?? pageSize;
    const params = { page: p, page_size: ps, sort_by: s.key, sort_dir: s.dir, vendor: v };
    Object.entries(f).forEach(([k, val]) => {
      if (k === 'status' && val === 'All') return;
      if (val) params[k] = val;
    });
    return params;
  }, [filters, vendorTab, sort, page, pageSize]);

  const load = useCallback((overrides) => {
    setLoading(true);
    listOrderSummary(buildParams(overrides))
      .then(res => { setItems(res.rows || []); setTotal(res.total || 0); })
      .catch(() => toast.error('Failed to load builty data'))
      .finally(() => setLoading(false));
  }, [buildParams]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    listCities()
      .then(rows => setCities(rows.filter(c => c.is_active).map(c => c.name)))
      .catch(() => {});
  }, []);

  useEffect(() => { setEdits({}); }, [items]);

  const setFilter = (k, v) => setFilters(f => ({ ...f, [k]: v }));
  const onSearchKey = (e) => { if (e.key === 'Enter') applySearch(); };
  const applySearch = () => { setPage(1); load({ page: 1 }); };
  const clearFilters = () => { const f = defaultFilters(); setFilters(f); setPage(1); load({ filters: f, page: 1 }); };

  const switchTab = (key) => {
    setVendorTab(key);
    setPage(1);
    load({ vendor: key, page: 1 });
  };

  const toggleSort = (key) => {
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
    persistPageSize('builty', size);
    setPage(1);
    load({ pageSize: size, page: 1 });
  };

  const valueOf = (po, key) => {
    const e = edits[po.po_id];
    return e && Object.prototype.hasOwnProperty.call(e, key) ? e[key] : po[key];
  };
  const isDirty = (po) => !!edits[po.po_id];
  const setEdit = (poId, patch) => setEdits(prev => ({ ...prev, [poId]: { ...(prev[poId] || {}), ...patch } }));
  const cancelEdit = (poId) => setEdits(prev => { const n = { ...prev }; delete n[poId]; return n; });
  const onCellKeyDown = (poId) => (e) => { if (e.key === 'Escape') cancelEdit(poId); };

  const saveRow = async (po) => {
    const e = edits[po.po_id];
    if (!e || !('bill_no' in e)) return;
    setSavingId(po.po_id);
    try {
      const value = (e.bill_no ?? '').trim();
      await updateOrderSummary(po.po_id, { bill_no: value === '' ? null : value });
      toast.success(`Saved ${po.po_id}`);
      cancelEdit(po.po_id);
      setConflict(null);
      load();
    } catch (err) {
      const data = err.response?.data;
      if (err.response?.status === 409 && data?.error === 'bill_no_duplicate') {
        setConflict({ po, billNo: (e.bill_no ?? '').trim(), rows: data.conflicts || [] });
      } else if (err.response?.status === 400) {
        toast.error(data?.message || 'Invalid bill no');
      } else {
        toast.error(data?.message || 'Save failed');
      }
    } finally { setSavingId(null); }
  };

  const downloadXLSX = async () => {
    setExporting(true);
    try {
      const params = buildParams({ pageSize: 'all', page: undefined });
      delete params.page; delete params.page_size;
      params.page_size = 'all';
      const res = await listOrderSummary(params);
      const rows = res.rows || [];
      if (rows.length === 0) {
        toast('No records to export');
        return;
      }
      const headers = COLUMNS.map(c => c.label);
      const data = rows.map(r => COLUMNS.map(c => {
        const v = r[c.key];
        return v == null ? '' : v;
      }));
      const ws = XLSX.utils.aoa_to_sheet([headers, ...data]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Builty');
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
      XLSX.writeFile(wb, `builty-${vendorTab.toLowerCase()}-${stamp}.xlsx`);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Export failed');
    } finally { setExporting(false); }
  };

  const inputCls = 'w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 disabled:bg-gray-50 disabled:text-gray-400';
  const cellCls = 'w-full px-2 py-1 border border-gray-200 rounded text-sm bg-white focus:outline-none focus:ring-1 focus:ring-[#c1121f]/40 disabled:bg-gray-100 disabled:text-gray-400';

  const SortIcon = ({ colKey }) => {
    if (sort.key !== colKey) return <ArrowUpDown size={12} className="text-gray-300" />;
    return sort.dir === 'asc'
      ? <ArrowUp size={12} className="text-[#c1121f]" />
      : <ArrowDown size={12} className="text-[#c1121f]" />;
  };

  return (
    <AppShell>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#003049]">Builty</h1>
          <p className="text-gray-500 text-sm">{total} order{total !== 1 ? 's' : ''} · {vendorTab}</p>
        </div>
        <Button variant="outline" onClick={downloadXLSX} loading={exporting}>
          <Download size={16} />Download XLSX
        </Button>
      </div>

      <div className="flex gap-1 mb-4 border-b border-gray-200">
        {VENDOR_TABS.map(t => (
          <button
            key={t.key}
            type="button"
            onClick={() => switchTab(t.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${vendorTab === t.key ? 'border-[#c1121f] text-[#c1121f]' : 'border-transparent text-gray-500 hover:text-[#003049]'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="bg-white border border-gray-200 rounded-xl p-4 mb-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Status</label>
            <select value={filters.status} onChange={e => setFilter('status', e.target.value)} className={inputCls}>
              <option value="All">All</option>
              <option value="Open">Open</option>
              <option value="Closed">Closed</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">PO ID</label>
            <input value={filters.po_id} onChange={e => setFilter('po_id', e.target.value)} onKeyDown={onSearchKey} placeholder="Search PO ID..." className={inputCls} />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Tracking ID</label>
            <input value={filters.tracking_id} onChange={e => setFilter('tracking_id', e.target.value)} onKeyDown={onSearchKey} placeholder="Search tracking..." className={inputCls} />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Bill no</label>
            <input value={filters.bill_no} onChange={e => setFilter('bill_no', e.target.value)} onKeyDown={onSearchKey} placeholder="Search bill no..." className={inputCls} />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">City</label>
            <select value={filters.city} onChange={e => setFilter('city', e.target.value)} className={inputCls}>
              <option value="">All cities</option>
              {cities.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">PO Date From</label>
            <input type="date" value={filters.po_date_from} onChange={e => setFilter('po_date_from', e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">PO Date To</label>
            <input type="date" value={filters.po_date_to} onChange={e => setFilter('po_date_to', e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Dispatch From</label>
            <input type="date" value={filters.dispatch_date_from} onChange={e => setFilter('dispatch_date_from', e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Dispatch To</label>
            <input type="date" value={filters.dispatch_date_to} onChange={e => setFilter('dispatch_date_to', e.target.value)} className={inputCls} />
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-3">
          <Button variant="ghost" onClick={clearFilters}>Clear</Button>
          <Button variant="outline" onClick={applySearch}>Search</Button>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-gray-50">
              <tr className="border-b border-gray-200">
                {COLUMNS.map(col => (
                  <th key={col.key} className="px-3 py-3 text-left font-semibold text-gray-600 whitespace-nowrap bg-gray-50">
                    <button type="button" onClick={() => toggleSort(col.key)} className="inline-flex items-center gap-1 hover:text-[#003049]">
                      {col.label}<SortIcon colKey={col.key} />
                    </button>
                  </th>
                ))}
                {canEdit && <th className="px-3 py-3 w-20 bg-gray-50" />}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                [...Array(4)].map((_, i) => (
                  <tr key={i}>
                    <td colSpan={COLUMNS.length + (canEdit ? 1 : 0)} className="px-4 py-3">
                      <div className="h-4 bg-gray-100 rounded animate-pulse" />
                    </td>
                  </tr>
                ))
              ) : items.map(po => {
                const dirty = isDirty(po);
                const editBillNo = valueOf(po, 'bill_no') ?? '';
                const onKey = onCellKeyDown(po.po_id);
                return (
                  <tr key={po.po_id} className={`border-b border-gray-100 ${dirty ? 'bg-amber-50/60' : 'hover:bg-gray-50'}`}>
                    {COLUMNS.map(col => {
                      switch (col.key) {
                        case 'po_id':
                        case 'vendor_po_id':
                          return <td key={col.key} className="px-3 py-2 font-mono text-gray-700 whitespace-nowrap">{po[col.key] || '—'}</td>;
                        case 'po_date':
                        case 'dispatch_date':
                          return <td key={col.key} className="px-3 py-2 text-gray-700 whitespace-nowrap">{po[col.key] || '—'}</td>;
                        case 'vendor':
                          return <td key={col.key} className="px-3 py-2 whitespace-nowrap">{po.vendor}</td>;
                        case 'party_name':
                          return <td key={col.key} className="px-3 py-2 text-gray-700">{po.party_name || '—'}</td>;
                        case 'total_qty':
                          return <td key={col.key} className="px-3 py-2 font-semibold text-gray-800">{po.total_qty ?? 0}</td>;
                        case 'city':
                          return <td key={col.key} className="px-3 py-2 text-gray-600 whitespace-nowrap">{po.city || '—'}</td>;
                        case 'courier_name':
                          return <td key={col.key} className="px-3 py-2 text-gray-700 whitespace-nowrap">{po.courier_name || '—'}</td>;
                        case 'tracking_id':
                          return <td key={col.key} className="px-3 py-2 text-gray-700 font-mono whitespace-nowrap">{po.tracking_id || '—'}</td>;
                        case 'bill_no':
                          return (
                            <td key={col.key} className="px-3 py-2">
                              {canEdit ? (
                                <input
                                  type="text"
                                  value={editBillNo}
                                  onChange={e => setEdit(po.po_id, { bill_no: e.target.value })}
                                  onKeyDown={onKey}
                                  placeholder="—"
                                  pattern="[A-Za-z0-9-]*"
                                  className={`${cellCls} font-mono`}
                                />
                              ) : (
                                <span className="text-gray-700 font-mono">{po.bill_no || '—'}</span>
                              )}
                            </td>
                          );
                        case 'updated_at':
                          return (
                            <td key={col.key} className="px-3 py-2 whitespace-nowrap">
                              <div className="text-gray-700">{po.updated_by_name || '—'}</div>
                              <div className="text-xs text-gray-400">{formatDateTime(po.updated_at)}</div>
                            </td>
                          );
                        default:
                          return <td key={col.key} className="px-3 py-2">{po[col.key]}</td>;
                      }
                    })}
                    {canEdit && (
                      <td className="px-3 py-2 whitespace-nowrap">
                        {dirty && (
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => saveRow(po)}
                              disabled={savingId === po.po_id}
                              title="Save"
                              className="p-1.5 rounded bg-[#c1121f] text-white hover:bg-[#a01019] disabled:opacity-40"
                            >
                              <Save size={14} />
                            </button>
                            <button
                              type="button"
                              onClick={() => cancelEdit(po.po_id)}
                              title="Cancel (Esc)"
                              className="p-1.5 rounded text-gray-500 hover:bg-gray-100"
                            >
                              <X size={14} />
                            </button>
                          </div>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!loading && items.length === 0 && (
            <p className="text-center text-gray-400 py-8">No orders match the current filters</p>
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

      <Modal
        isOpen={!!conflict}
        onClose={() => setConflict(null)}
        title="Bill no already in use"
        size="lg"
      >
        {conflict && (
          <div className="space-y-4 -mx-6 -my-4 px-6 py-4 border-y bg-red-50 border-red-200">
            <p className="text-sm text-red-700 font-medium">
              Bill no <span className="font-mono font-semibold">{conflict.billNo}</span> is already used on another PO. Bill numbers must be globally unique. Pick a different value.
            </p>
            <div className="border border-gray-200 rounded-lg overflow-hidden bg-white">
              <table className="w-full text-sm">
                <thead className="bg-red-100 text-red-900">
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold">PO ID</th>
                    <th className="px-3 py-2 text-left font-semibold">Vendor</th>
                    <th className="px-3 py-2 text-left font-semibold">Vendor PO No.</th>
                  </tr>
                </thead>
                <tbody>
                  {conflict.rows.map(c => (
                    <tr key={c.po_id} className="bg-red-50/60 border-t border-gray-100">
                      <td className="px-3 py-2 font-mono text-xs">{c.po_id}</td>
                      <td className="px-3 py-2">{c.vendor}</td>
                      <td className="px-3 py-2 font-mono text-xs">{c.vendor_po_id || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex justify-end">
              <Button onClick={() => setConflict(null)}>Close</Button>
            </div>
          </div>
        )}
      </Modal>
    </AppShell>
  );
}
