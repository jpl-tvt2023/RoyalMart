import { useEffect, useState, useCallback } from 'react';
import * as XLSX from 'xlsx';
import { ArrowUp, ArrowDown, ArrowUpDown, Download, Save, X } from 'lucide-react';
import toast from 'react-hot-toast';
import AppShell from '../../components/layout/AppShell';
import Button from '../../components/ui/Button';
import Badge from '../../components/ui/Badge';
import Pagination, { loadPersistedPageSize, persistPageSize } from '../../components/ui/Pagination';
import { listOrderSummary, updateOrderSummary, bulkUpdateOrderSummary } from '../../api/orderSummary.api';
import { getUsers } from '../../api/users.api';
import { formatDateTime } from '../../utils/formatters';
import { INDIAN_CITIES } from '../../data/indianCities';
import { useRBAC } from '../../hooks/useRBAC';

const VENDOR_TABS = [
  { key: '',         label: 'Master' },
  { key: 'Scootsy',  label: 'Scootsy' },
  { key: 'Zepto',    label: 'Zepto' },
  { key: 'Blinkit',  label: 'Blinkit' },
];

const STATUS_COLORS = { Open: 'blue', Closed: 'green' };

const defaultFilters = () => ({
  po_id: '', city: '',
  po_date_from: '', po_date_to: '',
  status: 'Open', office_poc: '', warehouse_poc: '',
});

// Server-side sort key for the merged "Last Updated" column.
const COLUMNS_MASTER = [
  { key: 'po_date',            label: 'Order Date' },
  { key: 'po_id',              label: 'PO ID' },
  { key: 'vendor',             label: 'Vendor' },
  { key: 'vendor_po_id',       label: 'PO No.' },
  { key: 'total_qty',          label: 'Quantity' },
  { key: 'line_count',         label: 'SKU' },
  { key: 'city',               label: 'Destination' },
  { key: 'office_poc_name',    label: 'Office POC' },
  { key: 'warehouse_poc_name', label: 'Warehouse POC' },
  { key: 'status',             label: 'Status' },
  { key: 'dispatch_date',      label: 'Dispatch Date' },
  { key: 'updated_at',         label: 'Last Updated' },
];
const COLUMNS_VENDOR = COLUMNS_MASTER.filter(c => c.key !== 'vendor');

const EXPORT_COLUMNS = [
  { key: 'po_date',            label: 'Order Date' },
  { key: 'po_id',              label: 'PO ID' },
  { key: 'vendor',             label: 'Vendor' },
  { key: 'vendor_po_id',       label: 'PO No.' },
  { key: 'total_qty',          label: 'Quantity' },
  { key: 'line_count',         label: 'SKU' },
  { key: 'city',               label: 'Destination' },
  { key: 'office_poc_name',    label: 'Office POC' },
  { key: 'warehouse_poc_name', label: 'Warehouse POC' },
  { key: 'status',             label: 'Status' },
  { key: 'dispatch_date',      label: 'Dispatch Date' },
  { key: null,                 label: 'Material Dispatch' },
];

export default function OrderSummaryList() {
  const { canAccess } = useRBAC();
  const canEdit = canAccess('Admin', 'Owner', 'Office_POC', 'PO_Executive');

  const [vendorTab, setVendorTab] = useState('');
  const [filters, setFilters] = useState(defaultFilters);
  const [sort, setSort] = useState({ key: 'updated_at', dir: 'desc' });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(() => loadPersistedPageSize('orderSummary', 25));

  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const [officePocs, setOfficePocs] = useState([]);
  const [warehousePocs, setWarehousePocs] = useState([]);

  // Per-row dirty edits, keyed by po_id. A row is in edit mode whenever it has
  // an entry here (i.e. the user has touched any of its cells).
  const [edits, setEdits] = useState({});
  const [savingId, setSavingId] = useState(null);

  // Bulk action state.
  const [selected, setSelected] = useState(new Set());
  const [bulkStatus, setBulkStatus] = useState('Closed');
  const [bulkDispatchDate, setBulkDispatchDate] = useState('');
  const [bulkApplying, setBulkApplying] = useState(false);

  const [exporting, setExporting] = useState(false);

  const COLUMNS = vendorTab ? COLUMNS_VENDOR : COLUMNS_MASTER;

  const buildParams = useCallback((overrides = {}) => {
    const f = overrides.filters ?? filters;
    const v = overrides.vendor ?? vendorTab;
    const s = overrides.sort ?? sort;
    const p = overrides.page ?? page;
    const ps = overrides.pageSize ?? pageSize;
    const params = { page: p, page_size: ps, sort_by: s.key, sort_dir: s.dir };
    if (v) params.vendor = v;
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
      .catch(() => toast.error('Failed to load order summary'))
      .finally(() => setLoading(false));
  }, [buildParams]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    getUsers()
      .then(r => {
        const users = r.data || [];
        setOfficePocs(users.filter(u => (u.roles || []).includes('Office_POC')));
        setWarehousePocs(users.filter(u => (u.roles || []).includes('Warehouse_POC')));
      })
      .catch(() => {});
  }, []);

  // Reset edit + selection state when the row set changes (refetch / tab / filter).
  useEffect(() => {
    setEdits({});
    setSelected(new Set());
  }, [items]);

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
    persistPageSize('orderSummary', size);
    setPage(1);
    load({ pageSize: size, page: 1 });
  };

  // ───── Edit mode ─────
  // Cells are always-editable. A row becomes "dirty" the moment any of its
  // controls is changed (entry exists in `edits`); Save/Cancel buttons render
  // in the action column for dirty rows only.
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
    if (!e) return;
    const nextStatus = 'status' in e ? e.status : po.status;
    const nextDispatch = 'dispatch_date' in e ? e.dispatch_date : po.dispatch_date;
    if (nextStatus === 'Closed' && !nextDispatch) {
      return toast.error('Dispatch date is required to close an order');
    }
    setSavingId(po.po_id);
    try {
      const payload = {};
      if ('office_poc' in e) payload.office_poc = e.office_poc === '' ? null : Number(e.office_poc);
      if ('warehouse_poc' in e) payload.warehouse_poc = e.warehouse_poc === '' ? null : Number(e.warehouse_poc);
      if ('status' in e) payload.status = e.status;
      if ('dispatch_date' in e || ('status' in e && e.status === 'Open')) {
        payload.dispatch_date = e.status === 'Open' ? null : (e.dispatch_date || null);
      }
      await updateOrderSummary(po.po_id, payload);
      toast.success(`Saved ${po.po_id}`);
      cancelEdit(po.po_id);
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Save failed');
    } finally { setSavingId(null); }
  };

  // ───── Bulk ─────
  const allSelected = items.length > 0 && items.every(po => selected.has(po.po_id));
  const toggleSelectAll = () => {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(items.map(p => p.po_id)));
  };
  const toggleSelect = (poId) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(poId)) next.delete(poId); else next.add(poId);
    return next;
  });
  const bulkApplyDisabled = selected.size === 0
    || bulkApplying
    || (bulkStatus === 'Closed' && !bulkDispatchDate);
  const applyBulk = async () => {
    if (bulkApplyDisabled) return;
    setBulkApplying(true);
    try {
      await bulkUpdateOrderSummary({
        po_ids: Array.from(selected),
        status: bulkStatus,
        dispatch_date: bulkStatus === 'Closed' ? bulkDispatchDate : null,
      });
      toast.success(`Updated ${selected.size} order${selected.size !== 1 ? 's' : ''}`);
      setSelected(new Set());
      setBulkDispatchDate('');
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Bulk update failed');
    } finally { setBulkApplying(false); }
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
      const headers = EXPORT_COLUMNS.map(c => c.label);
      const data = rows.map(r => EXPORT_COLUMNS.map(c => {
        if (c.key == null) return '';
        const v = r[c.key];
        return v == null ? '' : v;
      }));
      const ws = XLSX.utils.aoa_to_sheet([headers, ...data]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Order Summary');
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
      XLSX.writeFile(wb, `order-summary-${vendorTab || 'all'}-${stamp}.xlsx`);
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
          <h1 className="text-2xl font-bold text-[#003049]">Order Summary</h1>
          <p className="text-gray-500 text-sm">{total} order{total !== 1 ? 's' : ''}</p>
        </div>
        <Button variant="outline" onClick={downloadXLSX} loading={exporting}>
          <Download size={16} />Download XLSX
        </Button>
      </div>

      {/* Vendor tabs */}
      <div className="flex gap-1 mb-4 border-b border-gray-200">
        {VENDOR_TABS.map(t => (
          <button
            key={t.key || 'master'}
            type="button"
            onClick={() => switchTab(t.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${vendorTab === t.key ? 'border-[#c1121f] text-[#c1121f]' : 'border-transparent text-gray-500 hover:text-[#003049]'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Filter bar */}
      <div className="bg-white border border-gray-200 rounded-xl p-4 mb-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-7 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Status</label>
            <select value={filters.status} onChange={e => setFilter('status', e.target.value)} className={inputCls}>
              <option value="Open">Open</option>
              <option value="Closed">Closed</option>
              <option value="All">All</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">PO ID</label>
            <input value={filters.po_id} onChange={e => setFilter('po_id', e.target.value)} onKeyDown={onSearchKey} placeholder="Search PO ID..." className={inputCls} />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">City</label>
            <select value={filters.city} onChange={e => setFilter('city', e.target.value)} className={inputCls}>
              <option value="">All cities</option>
              {INDIAN_CITIES.map(c => <option key={c} value={c}>{c}</option>)}
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
            <label className="block text-xs font-medium text-gray-600 mb-1">Office POC</label>
            <select value={filters.office_poc} onChange={e => setFilter('office_poc', e.target.value)} className={inputCls}>
              <option value="">All</option>
              <option value="unassigned">Unassigned</option>
              {officePocs.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Warehouse POC</label>
            <select value={filters.warehouse_poc} onChange={e => setFilter('warehouse_poc', e.target.value)} className={inputCls}>
              <option value="">All</option>
              <option value="unassigned">Unassigned</option>
              {warehousePocs.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-3">
          <Button variant="ghost" onClick={clearFilters}>Clear</Button>
          <Button variant="outline" onClick={applySearch}>Search</Button>
        </div>
      </div>

      {/* Bulk action bar */}
      {canEdit && selected.size > 0 && (
        <div className="bg-[#003049] text-white rounded-xl px-4 py-3 mb-3 flex items-center gap-3 flex-wrap sticky top-2 z-20 shadow">
          <span className="font-medium whitespace-nowrap">{selected.size} selected</span>
          <span className="text-white/40">·</span>
          <label className="text-sm whitespace-nowrap">Set status</label>
          <select
            value={bulkStatus}
            onChange={e => setBulkStatus(e.target.value)}
            className="px-2 py-1.5 rounded text-sm text-[#003049] bg-white border border-white/20 min-w-[7rem]"
          >
            <option value="Open">Open</option>
            <option value="Closed">Closed</option>
          </select>
          <label className="text-sm whitespace-nowrap">Dispatch</label>
          <input
            type="date"
            value={bulkDispatchDate}
            onChange={e => setBulkDispatchDate(e.target.value)}
            disabled={bulkStatus !== 'Closed'}
            className="px-2 py-1.5 rounded text-sm text-[#003049] bg-white border border-white/20 min-w-[9rem] disabled:opacity-40 disabled:cursor-not-allowed"
          />
          <Button
            onClick={applyBulk}
            disabled={bulkApplyDisabled}
            loading={bulkApplying}
            title={bulkStatus === 'Closed' && !bulkDispatchDate ? 'Dispatch date is required to close orders' : undefined}
          >
            Apply
          </Button>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="text-white/80 hover:text-white text-sm underline whitespace-nowrap"
          >
            Clear selection
          </button>
        </div>
      )}

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-gray-50">
              <tr className="border-b border-gray-200">
                {canEdit && (
                  <th className="px-3 py-3 w-10 bg-gray-50">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleSelectAll}
                      aria-label="Select all"
                    />
                  </th>
                )}
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
                    <td colSpan={COLUMNS.length + (canEdit ? 2 : 0)} className="px-4 py-3">
                      <div className="h-4 bg-gray-100 rounded animate-pulse" />
                    </td>
                  </tr>
                ))
              ) : items.map(po => {
                const dirty = isDirty(po);
                const editStatus = valueOf(po, 'status') || 'Open';
                const editDispatch = valueOf(po, 'dispatch_date') || '';
                const editOffice = valueOf(po, 'office_poc');
                const editWarehouse = valueOf(po, 'warehouse_poc');
                const onKey = onCellKeyDown(po.po_id);
                return (
                  <tr key={po.po_id} className={`border-b border-gray-100 ${dirty ? 'bg-amber-50/60' : 'hover:bg-gray-50'}`}>
                    {canEdit && (
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          checked={selected.has(po.po_id)}
                          onChange={() => toggleSelect(po.po_id)}
                        />
                      </td>
                    )}
                    {COLUMNS.map(col => {
                      switch (col.key) {
                        case 'po_date':
                        case 'vendor_po_id':
                        case 'po_id':
                          return <td key={col.key} className="px-3 py-2 font-mono text-gray-700 whitespace-nowrap">{po[col.key] || '—'}</td>;
                        case 'vendor':
                          return <td key={col.key} className="px-3 py-2 whitespace-nowrap">{po.vendor}</td>;
                        case 'total_qty':
                        case 'line_count':
                          return <td key={col.key} className="px-3 py-2 font-semibold text-gray-800">{po[col.key] ?? 0}</td>;
                        case 'city':
                          return <td key={col.key} className="px-3 py-2 text-gray-600 whitespace-nowrap">{po.city || '—'}</td>;

                        case 'office_poc_name':
                          return (
                            <td key={col.key} className="px-3 py-2">
                              {canEdit ? (
                                <select
                                  value={editOffice == null ? '' : String(editOffice)}
                                  onChange={e => setEdit(po.po_id, { office_poc: e.target.value })}
                                  onKeyDown={onKey}
                                  className={cellCls}
                                >
                                  <option value="">— Unassigned —</option>
                                  {officePocs.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                                </select>
                              ) : (
                                <span className="text-gray-700">{po.office_poc_name || '—'}</span>
                              )}
                            </td>
                          );

                        case 'warehouse_poc_name':
                          return (
                            <td key={col.key} className="px-3 py-2">
                              {canEdit ? (
                                <select
                                  value={editWarehouse == null ? '' : String(editWarehouse)}
                                  onChange={e => setEdit(po.po_id, { warehouse_poc: e.target.value })}
                                  onKeyDown={onKey}
                                  className={cellCls}
                                >
                                  <option value="">— Unassigned —</option>
                                  {warehousePocs.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                                </select>
                              ) : (
                                <span className="text-gray-700">{po.warehouse_poc_name || '—'}</span>
                              )}
                            </td>
                          );

                        case 'status':
                          return (
                            <td key={col.key} className="px-3 py-2">
                              {canEdit ? (
                                <select
                                  value={editStatus}
                                  onChange={e => {
                                    const v = e.target.value;
                                    const patch = { status: v };
                                    if (v === 'Open') patch.dispatch_date = '';
                                    setEdit(po.po_id, patch);
                                  }}
                                  onKeyDown={onKey}
                                  className={cellCls}
                                >
                                  <option value="Open">Open</option>
                                  <option value="Closed">Closed</option>
                                </select>
                              ) : (
                                <Badge color={STATUS_COLORS[po.status] || 'gray'}>{po.status || 'Open'}</Badge>
                              )}
                            </td>
                          );

                        case 'dispatch_date':
                          return (
                            <td key={col.key} className="px-3 py-2">
                              {canEdit ? (
                                <input
                                  type="date"
                                  value={editDispatch || ''}
                                  disabled={editStatus !== 'Closed'}
                                  onChange={e => setEdit(po.po_id, { dispatch_date: e.target.value })}
                                  onKeyDown={onKey}
                                  className={cellCls}
                                />
                              ) : (
                                <span className="text-gray-700">{po.dispatch_date || '—'}</span>
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
    </AppShell>
  );
}
