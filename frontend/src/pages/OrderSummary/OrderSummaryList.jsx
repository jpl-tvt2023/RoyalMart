import { useEffect, useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import * as XLSX from 'xlsx';
import { ArrowUp, ArrowDown, ArrowUpDown, Download, Save, X, ChevronDown, ChevronUp } from 'lucide-react';
import toast from 'react-hot-toast';
import AppShell from '../../components/layout/AppShell';
import Button from '../../components/ui/Button';
import Badge from '../../components/ui/Badge';
import Modal from '../../components/ui/Modal';
import Legend from '../../components/ui/Legend';
import Pagination, { loadPersistedPageSize, persistPageSize } from '../../components/ui/Pagination';
import { useSessionState } from '../../hooks/useSessionState';
import { listOrderSummary, updateOrderSummary, bulkUpdateOrderSummary, getPocUsers } from '../../api/orderSummary.api';
import { listVendors } from '../../api/vendors.api';
import { listCities } from '../../api/cities.api';
import { listCouriers } from '../../api/couriers.api';
import { sortByText } from '../../utils/sort';
import { formatDateTime } from '../../utils/formatters';
import { usesPickupDate } from '../../utils/pickupDate';
import { HistoryButton } from '../../components/shared/HistoryDrawer';
import { useRBAC } from '../../hooks/useRBAC';

const STATUS_COLORS = { Open: 'blue', Closed: 'green' };

// Row highlight for rows with edits not yet saved (single source for row + legend).
const DIRTY_ROW = 'bg-amber-50/60';
const UNSAVED_LEGEND = [{ swatch: DIRTY_ROW, label: 'Unsaved changes' }];

const todayISO = () => new Date().toISOString().slice(0, 10);

const defaultFilters = () => ({
  po_id: '', city: '',
  po_date_from: '', po_date_to: '',
  dispatch_date_from: '', dispatch_date_to: '',
  status: 'Open', office_poc: '', warehouse_poc: '',
  courier_id: '', has_tracking: '', tracking_id: '',
});

const seededFiltersFromURL = (params) => {
  const base = defaultFilters();
  if (!params) return base;
  for (const [k, v] of params.entries()) {
    if (k in base && v) base[k] = v;
  }
  return base;
};

// True when the URL carries a filter or vendor value (deep link). A bare
// navigate-back has none, so the session-restored state is kept instead.
const urlHasFilters = (params) => {
  if (!params) return false;
  if (params.get('vendor')) return true;
  return Object.keys(defaultFilters()).some(k => params.get(k));
};

// The effective-date column is labelled per tab: a vendor tab shows the vendor's
// own date term, the Master tab shows the combined label.
const expiryPickupLabel = (vendorTab) =>
  vendorTab ? (usesPickupDate(vendorTab) ? 'Pickup Date' : 'Expiry Date') : 'Expiry/Pickup Date';

const buildColumns = (vendorTab) => {
  const cols = [
    { key: 'po_date',            label: 'Order Date' },
    { key: 'po_id',              label: 'PO ID' },
    { key: 'vendor',             label: 'Vendor' },
    { key: 'vendor_po_id',       label: 'PO No.' },
    { key: 'total_qty',          label: 'Quantity' },
    { key: 'line_count',         label: 'SKU' },
    { key: 'city',               label: 'City' },
    { key: 'expiry_or_pickup',   label: expiryPickupLabel(vendorTab) },
    { key: 'office_poc_name',    label: 'Office POC' },
    { key: 'warehouse_poc_name', label: 'Warehouse POC' },
    { key: 'status',             label: 'Status' },
    { key: 'dispatch_date',      label: 'Dispatch Date' },
    { key: 'courier_name',       label: 'Courier' },
    { key: 'tracking_id',        label: 'Tracking ID' },
    { key: 'box',                label: 'Box' },
    { key: 'updated_at',         label: 'Last Updated' },
  ];
  return vendorTab ? cols.filter(c => c.key !== 'vendor') : cols;
};

export default function OrderSummaryList() {
  const { canEdit } = useRBAC();

  const [searchParams] = useSearchParams();
  const [vendorTabs, setVendorTabs] = useState([{ key: '', label: 'Master' }]);
  const [vendorTab, setVendorTab] = useSessionState('orderSummary.vendorTab', '');
  const [filters, setFilters] = useSessionState('orderSummary.filters', defaultFilters);
  const [showMore, setShowMore] = useState(false);
  const [sort, setSort] = useSessionState('orderSummary.sort', { key: 'updated_at', dir: 'desc' });
  const [page, setPage] = useSessionState('orderSummary.page', 1);
  const [pageSize, setPageSize] = useState(() => loadPersistedPageSize('orderSummary', 25));

  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const [officePocs, setOfficePocs] = useState([]);
  const [warehousePocs, setWarehousePocs] = useState([]);
  const [cities, setCities] = useState([]);
  const [couriers, setCouriers] = useState([]);
  const activeCouriers = couriers.filter(c => c.is_active);

  const [edits, setEdits] = useState({});
  const [savingId, setSavingId] = useState(null);

  const [selected, setSelected] = useState(new Set());
  const [bulkOfficePoc, setBulkOfficePoc] = useState('');
  const [bulkWarehousePoc, setBulkWarehousePoc] = useState('');
  const [bulkApplying, setBulkApplying] = useState(false);

  const [exporting, setExporting] = useState(false);
  const [conflict, setConflict] = useState(null);

  const COLUMNS = buildColumns(vendorTab);

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

  // Load on mount and whenever the URL (navigation) changes. Editing filter inputs
  // does NOT fetch — only an explicit action (Search/Clear/tab/sort/pagination).
  // Seeded values are passed as overrides so the fetch doesn't race setState.
  // A deep link with filter/vendor params wins; a bare navigate-back keeps the
  // state restored from sessionStorage instead of resetting to defaults.
  useEffect(() => {
    const DEFAULTS = defaultFilters();
    const autoExpand = (f) => {
      const hasNonStatusFilter = Object.entries(f).some(([k, val]) => k !== 'status' && val !== DEFAULTS[k]);
      if (hasNonStatusFilter) setShowMore(true);
    };
    if (urlHasFilters(searchParams)) {
      const seeded = seededFiltersFromURL(searchParams);
      const v = searchParams.get('vendor') || '';
      setFilters(seeded);
      setVendorTab(v);
      setPage(1);
      autoExpand(seeded);
      load({ filters: seeded, vendor: v, page: 1 });
    } else {
      autoExpand(filters);
      load({ filters, vendor: vendorTab, page });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const DEFAULTS = defaultFilters();
  const hiddenActiveCount = Object.entries(filters).reduce((n, [k, v]) => {
    if (k === 'status') return n;
    return v !== DEFAULTS[k] ? n + 1 : n;
  }, 0);

  useEffect(() => {
    getPocUsers()
      .then(users => {
        // Only users explicitly tagged with the POC role are assignable —
        // Admin/Owner are NOT auto-included (that's why qualifiesAs isn't used here).
        setOfficePocs(sortByText(users.filter(u => (u.roles || []).includes('Office_POC')), u => u.name));
        setWarehousePocs(sortByText(users.filter(u => (u.roles || []).includes('Warehouse_POC')), u => u.name));
      })
      .catch(() => {});
    listVendors()
      .then(rows => {
        const tabs = [{ key: '', label: 'Master' }, ...rows.filter(v => v.is_active).map(v => ({ key: v.name, label: v.name }))];
        setVendorTabs(tabs);
      })
      .catch(() => {});
    listCities()
      .then(rows => setCities(sortByText(rows.filter(c => c.is_active).map(c => c.name))))
      .catch(() => {});
    listCouriers()
      .then(rows => setCouriers(sortByText(rows, c => c.name)))
      .catch(() => {});
  }, []);

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

  const valueOf = (po, key) => {
    const e = edits[po.po_id];
    return e && Object.prototype.hasOwnProperty.call(e, key) ? e[key] : po[key];
  };
  const isDirty = (po) => !!edits[po.po_id];
  const setEdit = (poId, patch) => setEdits(prev => ({ ...prev, [poId]: { ...(prev[poId] || {}), ...patch } }));
  const cancelEdit = (poId) => setEdits(prev => { const n = { ...prev }; delete n[poId]; return n; });
  const onCellKeyDown = (poId) => (e) => { if (e.key === 'Escape') cancelEdit(poId); };

  const saveRow = async (po, { confirmDuplicate = false } = {}) => {
    const e = edits[po.po_id];
    if (!e) return;
    const nextStatus   = 'status' in e ? e.status : po.status;
    const nextDispatch = 'dispatch_date' in e ? e.dispatch_date : po.dispatch_date;
    const nextCourier  = 'courier_id'    in e ? e.courier_id    : po.courier_id;
    const nextTracking = 'tracking_id'   in e ? e.tracking_id   : po.tracking_id;
    const nextBox       = 'box'          in e ? e.box           : po.box;
    if (nextStatus === 'Closed') {
      const missing = [];
      if (!nextDispatch) missing.push('dispatch date');
      if (nextCourier == null || nextCourier === '') missing.push('courier');
      if (!String(nextTracking ?? '').trim()) missing.push('tracking ID');
      if (nextBox == null || nextBox === '' || !Number.isInteger(Number(nextBox)) || Number(nextBox) < 1) missing.push('box');
      if (missing.length) return toast.error(`Cannot close — missing: ${missing.join(', ')}`);
    }
    setSavingId(po.po_id);
    try {
      const payload = {};
      if ('office_poc' in e) payload.office_poc = e.office_poc === '' ? null : Number(e.office_poc);
      if ('warehouse_poc' in e) payload.warehouse_poc = e.warehouse_poc === '' ? null : Number(e.warehouse_poc);
      if ('status' in e) payload.status = e.status;
      const reopening = 'status' in e && e.status === 'Open';
      if ('dispatch_date' in e || reopening) {
        payload.dispatch_date = reopening ? null : (e.dispatch_date || null);
      }
      if ('courier_id' in e || reopening) {
        payload.courier_id = reopening ? null : (e.courier_id === '' || e.courier_id == null ? null : Number(e.courier_id));
      }
      if ('tracking_id' in e || reopening) {
        payload.tracking_id = reopening ? null : ((e.tracking_id ?? '').trim() || null);
      }
      if ('box' in e || reopening) {
        payload.box = reopening ? null : (e.box === '' || e.box == null ? null : Number(e.box));
      }
      if (confirmDuplicate) payload.confirm_duplicate_tracking = true;
      await updateOrderSummary(po.po_id, payload);
      toast.success(`Saved ${po.po_id}`);
      cancelEdit(po.po_id);
      setConflict(null);
      load();
    } catch (err) {
      const data = err.response?.data;
      if (err.response?.status === 409 && data?.severity === 'error' && data?.error === 'tracking_id_vendor_conflict') {
        setConflict({ severity: 'error', po, trackingId: data.tracking_id, rows: data.conflicts || [], reason: 'vendor' });
      } else if (err.response?.status === 409 && data?.severity === 'error' && data?.error === 'tracking_id_city_conflict') {
        setConflict({ severity: 'error', po, trackingId: data.tracking_id, rows: data.conflicts || [], reason: 'city' });
      } else if (err.response?.status === 409 && data?.severity === 'warning' && data?.error === 'tracking_id_duplicate_same_vendor') {
        setConflict({ severity: 'warning', po, trackingId: data.tracking_id, rows: data.duplicates || [], reason: 'same' });
      } else {
        toast.error(data?.message || 'Save failed');
      }
    } finally { setSavingId(null); }
  };

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
    || (bulkOfficePoc === '' && bulkWarehousePoc === '');
  const applyBulk = async () => {
    if (bulkApplyDisabled) return;
    setBulkApplying(true);
    try {
      const payload = { po_ids: Array.from(selected) };
      if (bulkOfficePoc !== '') {
        payload.office_poc = bulkOfficePoc === 'clear' ? null : Number(bulkOfficePoc);
      }
      if (bulkWarehousePoc !== '') {
        payload.warehouse_poc = bulkWarehousePoc === 'clear' ? null : Number(bulkWarehousePoc);
      }
      await bulkUpdateOrderSummary(payload);
      toast.success(`Updated ${selected.size} order${selected.size !== 1 ? 's' : ''}`);
      setSelected(new Set());
      setBulkOfficePoc('');
      setBulkWarehousePoc('');
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
      // Derive export columns from the same definition the table renders (master
      // set, so Vendor + Last Updated are always included), then append the blank
      // Material Dispatch filler. Keeps the file in lockstep with the on-screen columns.
      const exportCols = [
        ...buildColumns(null),
        { key: null, label: 'Material Dispatch' },
      ];
      const headers = exportCols.map(c => c.label);
      const data = rows.map(r => exportCols.map(c => {
        if (c.key == null) return '';
        const v = r[c.key];
        return v == null ? '' : v;
      }));
      // Lead with the headline total quantity, then a spacer, then the table.
      const totalQty = rows.reduce((s, r) => s + (Number(r.total_qty) || 0), 0);
      const ws = XLSX.utils.aoa_to_sheet([['Total Quantity', totalQty], [], headers, ...data]);
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
  // In-cell dropdowns hold names/labels: keep a readable min-width so they don't
  // collapse on narrow screens — the table scrolls horizontally instead.
  const cellSelectCls = `${cellCls} min-w-[9rem]`;

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
      <div className="overflow-x-auto mb-4 border-b border-gray-200">
        <div className="flex gap-1 whitespace-nowrap">
          {vendorTabs.map(t => (
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
      </div>

      {/* Filter bar */}
      <div className="bg-white border border-gray-200 rounded-xl p-4 mb-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-full sm:w-56">
            <label className="block text-xs font-medium text-gray-600 mb-1">Status</label>
            <select value={filters.status} onChange={e => setFilter('status', e.target.value)} className={inputCls}>
              <option value="Open">Open</option>
              <option value="Closed">Closed</option>
              <option value="All">All</option>
            </select>
          </div>
          <button
            type="button"
            onClick={() => setShowMore(s => !s)}
            className="ml-auto inline-flex items-center gap-1 text-sm font-medium text-[#003049] hover:text-[#c1121f] transition-colors"
          >
            {showMore ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            {showMore ? 'Less filters' : 'More filters'}
            {!showMore && hiddenActiveCount > 0 && (
              <span className="ml-1 px-1.5 py-0.5 rounded-full text-xs bg-[#c1121f] text-white">{hiddenActiveCount}</span>
            )}
          </button>
        </div>

        {showMore && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 mt-3 pt-3 border-t border-gray-100">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">PO ID</label>
              <input value={filters.po_id} onChange={e => setFilter('po_id', e.target.value)} onKeyDown={onSearchKey} placeholder="Search PO ID..." className={inputCls} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Tracking ID</label>
              <input value={filters.tracking_id} onChange={e => setFilter('tracking_id', e.target.value)} onKeyDown={onSearchKey} placeholder="Search tracking ID..." className={inputCls} />
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
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Dispatch From</label>
              <input type="date" value={filters.dispatch_date_from} onChange={e => setFilter('dispatch_date_from', e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Dispatch To</label>
              <input type="date" value={filters.dispatch_date_to} onChange={e => setFilter('dispatch_date_to', e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Courier</label>
              <select value={filters.courier_id} onChange={e => setFilter('courier_id', e.target.value)} className={inputCls}>
                <option value="">All couriers</option>
                <option value="unassigned">Unassigned</option>
                {activeCouriers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2 mt-3">
          <Button variant="ghost" onClick={clearFilters}>Clear</Button>
          <Button variant="outline" onClick={applySearch}>Search</Button>
        </div>
      </div>

      {/* Bulk action bar */}
      {canEdit && selected.size > 0 && (
        <div className="bg-[#003049] text-white rounded-xl px-4 py-3 mb-3 overflow-x-auto sticky top-2 z-20 shadow">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="font-medium whitespace-nowrap">{selected.size} selected</span>
            <span className="text-white/40 hidden sm:inline">·</span>
            <label className="text-sm whitespace-nowrap hidden sm:inline">Office POC</label>
            <select
              value={bulkOfficePoc}
              onChange={e => setBulkOfficePoc(e.target.value)}
              className="px-2 py-1.5 rounded text-sm text-[#003049] bg-white border border-white/20 min-w-[8rem]"
            >
              <option value="">— Office POC —</option>
              <option value="clear">— Unassign —</option>
              {officePocs.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
            <label className="text-sm whitespace-nowrap hidden sm:inline">Warehouse POC</label>
            <select
              value={bulkWarehousePoc}
              onChange={e => setBulkWarehousePoc(e.target.value)}
              className="px-2 py-1.5 rounded text-sm text-[#003049] bg-white border border-white/20 min-w-[8rem]"
            >
              <option value="">— Warehouse POC —</option>
              <option value="clear">— Unassign —</option>
              {warehousePocs.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
            <Button
              onClick={applyBulk}
              disabled={bulkApplyDisabled}
              loading={bulkApplying}
              title={bulkOfficePoc === '' && bulkWarehousePoc === '' ? 'Pick an Office POC or Warehouse POC value to apply' : undefined}
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
        </div>
      )}

      {/* Table */}
      <Legend items={UNSAVED_LEGEND} className="mb-2" />

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto scrollbar-thin">
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
                const editCourier  = valueOf(po, 'courier_id');
                const editTracking = valueOf(po, 'tracking_id') ?? '';
                const editBox = valueOf(po, 'box') ?? '';
                const onKey = onCellKeyDown(po.po_id);
                return (
                  <tr key={po.po_id} className={`border-b border-gray-100 ${dirty ? DIRTY_ROW : 'hover:bg-gray-50'}`}>
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
                        case 'expiry_or_pickup':
                          return <td key={col.key} className="px-3 py-2 text-gray-600 whitespace-nowrap">{po.expiry_or_pickup || '—'}</td>;

                        case 'office_poc_name':
                          return (
                            <td key={col.key} className="px-3 py-2">
                              {canEdit ? (
                                <select
                                  value={editOffice == null ? '' : String(editOffice)}
                                  onChange={e => setEdit(po.po_id, { office_poc: e.target.value })}
                                  onKeyDown={onKey}
                                  className={cellSelectCls}
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
                                  className={cellSelectCls}
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
                                    if (v === 'Open') {
                                      patch.dispatch_date = '';
                                      patch.courier_id = '';
                                      patch.tracking_id = '';
                                      patch.box = '';
                                    }
                                    setEdit(po.po_id, patch);
                                  }}
                                  onKeyDown={onKey}
                                  className={cellSelectCls}
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
                                  max={todayISO()}
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

                        case 'courier_name':
                          return (
                            <td key={col.key} className="px-3 py-2">
                              {canEdit ? (
                                <select
                                  value={editCourier == null ? '' : String(editCourier)}
                                  disabled={editStatus !== 'Closed'}
                                  onChange={e => {
                                    const v = e.target.value;
                                    const patch = { courier_id: v };
                                    if (v === '') patch.tracking_id = '';
                                    setEdit(po.po_id, patch);
                                  }}
                                  onKeyDown={onKey}
                                  className={cellSelectCls}
                                >
                                  <option value="">— Unassigned —</option>
                                  {activeCouriers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                                  {po.courier_id && !activeCouriers.some(c => c.id === po.courier_id) && po.courier_name && (
                                    <option value={po.courier_id}>{po.courier_name} (inactive)</option>
                                  )}
                                </select>
                              ) : (
                                <span className="text-gray-700">{po.courier_name || '—'}</span>
                              )}
                            </td>
                          );

                        case 'tracking_id':
                          return (
                            <td key={col.key} className="px-3 py-2">
                              {canEdit ? (
                                <input
                                  type="text"
                                  value={editTracking}
                                  disabled={editStatus !== 'Closed' || editCourier == null || editCourier === ''}
                                  onChange={e => setEdit(po.po_id, { tracking_id: e.target.value })}
                                  onKeyDown={onKey}
                                  placeholder="—"
                                  className={`${cellCls} font-mono`}
                                />
                              ) : (
                                <span className="text-gray-700 font-mono">{po.tracking_id || '—'}</span>
                              )}
                            </td>
                          );

                        case 'box':
                          return (
                            <td key={col.key} className="px-3 py-2">
                              {canEdit ? (
                                <input
                                  type="number"
                                  min={1}
                                  step={1}
                                  value={editBox}
                                  disabled={editStatus !== 'Closed' || editCourier == null || editCourier === ''}
                                  onChange={e => setEdit(po.po_id, { box: e.target.value })}
                                  onKeyDown={onKey}
                                  placeholder="—"
                                  className={cellCls}
                                />
                              ) : (
                                <span className="text-gray-700">{po.box ?? '—'}</span>
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
                        <div className="flex items-center gap-1">
                          {dirty && (
                            <>
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
                            </>
                          )}
                          <HistoryButton entityType="marketplace_po" entityId={po.po_id} title={`History — ${po.po_id}`} />
                        </div>
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
        title={
          conflict?.severity === 'warning' ? 'Duplicate tracking ID on the same vendor'
          : conflict?.reason === 'city'    ? 'Tracking ID already used for a different city'
                                           : 'Tracking ID conflict'
        }
        size="lg"
      >
        {conflict && (() => {
          const isWarn   = conflict.severity === 'warning';
          const isCity   = conflict.reason === 'city';
          const wrapCls   = isWarn ? 'bg-amber-50 border-amber-200' : 'bg-red-50 border-red-200';
          const rowCls    = isWarn ? 'bg-amber-50/60' : 'bg-red-50/60';
          const headerCls = isWarn ? 'bg-amber-100 text-amber-900' : 'bg-red-100 text-red-900';
          const accent    = isWarn ? 'text-amber-700' : 'text-red-700';
          return (
            <div className={`space-y-4 -mx-6 -my-4 px-6 py-4 border-y ${wrapCls}`}>
              <p className={`text-sm ${accent} font-medium`}>
                {isWarn
                  ? <>This tracking ID is already on another PO for vendor <span className="font-semibold">{conflict.po.vendor}</span>. Please verify it isn&apos;t a mistake — you can either edit it or save anyway.</>
                  : isCity
                  ? <>Tracking ID <span className="font-mono font-semibold">{conflict.trackingId}</span> is already used by the same vendor on a PO shipping to a different city. Use a different ID or correct the city.</>
                  : <>Tracking ID <span className="font-mono font-semibold">{conflict.trackingId}</span> is already used by a different vendor. Tracking IDs can repeat within the same vendor but must be unique across vendors.</>}
              </p>
              <p className="text-sm text-gray-700">
                Editing <span className="font-mono font-semibold">{conflict.po.vendor_po_id || conflict.po.po_id}</span>
                {' '}(vendor <span className="font-semibold">{conflict.po.vendor}</span>{conflict.po.city ? <>, city <span className="font-semibold">{conflict.po.city}</span></> : null}) with tracking ID <span className="font-mono font-semibold">{conflict.trackingId}</span>.
                {' '}{isWarn ? 'Existing PO(s) using the same tracking ID:' : 'The following existing record(s) conflict:'}
              </p>
              <div className="border border-gray-200 rounded-lg overflow-hidden bg-white">
                <table className="w-full text-sm">
                  <thead className={headerCls}>
                    <tr>
                      <th className="px-3 py-2 text-left font-semibold">PO Number</th>
                      <th className="px-3 py-2 text-left font-semibold">Vendor</th>
                      <th className="px-3 py-2 text-left font-semibold">City</th>
                      <th className="px-3 py-2 text-left font-semibold">Dispatch Date</th>
                      <th className="px-3 py-2 text-left font-semibold">Tracking ID</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className={`${rowCls} border-t border-gray-100`}>
                      <td className="px-3 py-2 font-mono text-xs">{conflict.po.vendor_po_id || conflict.po.po_id}</td>
                      <td className="px-3 py-2">{conflict.po.vendor}</td>
                      <td className="px-3 py-2">{conflict.po.city || '—'}</td>
                      <td className="px-3 py-2 font-mono text-xs">{valueOf(conflict.po, 'dispatch_date') || '—'}</td>
                      <td className="px-3 py-2 font-mono text-xs">{conflict.trackingId} <span className="text-gray-400">(this edit)</span></td>
                    </tr>
                    {conflict.rows.map(c => (
                      <tr key={c.po_id} className={`${rowCls} border-t border-gray-100`}>
                        <td className="px-3 py-2 font-mono text-xs">{c.vendor_po_id || c.po_id}</td>
                        <td className="px-3 py-2">{c.vendor}</td>
                        <td className="px-3 py-2">{c.city || '—'}</td>
                        <td className="px-3 py-2 font-mono text-xs">{c.dispatch_date || '—'}</td>
                        <td className="px-3 py-2 font-mono text-xs">{c.tracking_id}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex justify-end gap-2">
                {isWarn ? (
                  <>
                    <Button variant="ghost" onClick={() => setConflict(null)}>Edit Tracking ID</Button>
                    <Button
                      onClick={() => saveRow(conflict.po, { confirmDuplicate: true })}
                      loading={savingId === conflict.po.po_id}
                    >
                      Save Anyway
                    </Button>
                  </>
                ) : (
                  <Button onClick={() => setConflict(null)}>Close</Button>
                )}
              </div>
            </div>
          );
        })()}
      </Modal>
    </AppShell>
  );
}
