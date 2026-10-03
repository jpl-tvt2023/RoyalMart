import { useEffect, useState, useCallback } from 'react';
import * as XLSX from 'xlsx';
import { ArrowUp, ArrowDown, ArrowUpDown, Download, Save, X } from 'lucide-react';
import toast from 'react-hot-toast';
import AppShell from '../../components/layout/AppShell';
import Button from '../../components/ui/Button';
import Badge from '../../components/ui/Badge';
import Legend from '../../components/ui/Legend';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import MultiSelect from '../../components/ui/MultiSelect';
import Pagination, { loadPersistedPageSize, persistPageSize } from '../../components/ui/Pagination';
import { HistoryButton } from '../../components/shared/HistoryDrawer';
import { useSessionState } from '../../hooks/useSessionState';
import { useRBAC } from '../../hooks/useRBAC';
import { listRtv, getRtvCountsByVendor, updateRtv } from '../../api/rtv.api';
import { listVendors } from '../../api/vendors.api';
import { listCities } from '../../api/cities.api';
import { listCouriers } from '../../api/couriers.api';
import { listUsersLite } from '../../api/users.api';
import { ROLES } from '../../utils/roles';
import { sortByText } from '../../utils/sort';
import { formatDateTime } from '../../utils/formatters';
import { isValidDateString } from '../../utils/dateValidation';
import { checkerOptionsFor } from '../../utils/checkers';
import {
  RTV_STATUSES, DN_DISPOSED, BLANK_STATUS, DELIVERED_VALUES, STATUS_COLORS,
  AFTER_STATUS, rtvRowError,
} from '../../utils/rtv';

// RTV — goods a marketplace sends back, tracked until they are back in the
// warehouse or a credit note is in hand (migration 092). A PO lands here when
// the GRN page marks it Returned to Vendor or records a discrepancy, and leaves
// when that stops being true — its details are kept and come back with it.
//
// Same shape as the GRN page it is fed from: vendor tabs, a filter panel, and a
// grid edited in place, one Save per row.

// Unsaved edits, one source for the row and the legend.
const DIRTY_ROW = 'bg-amber-50/60';
const LEGEND = [{ swatch: DIRTY_ROW, label: 'Unsaved changes' }];

// The Status filter: the three statuses plus "nobody has picked one yet".
const STATUS_FILTER_OPTIONS = [...RTV_STATUSES, BLANK_STATUS];
const statusFilterLabel = (v) => (v === BLANK_STATUS ? 'Not set' : v);
const NONE_SELECTED = '__none_selected__';

// v1 of the filter shape. Bump the session key if it changes.
const defaultFilters = () => ({
  q: '',
  status: [...STATUS_FILTER_OPTIONS],
  city: '',
  inward_courier_id: '',
  cn_date_from: '',
  cn_date_to: '',
  delivery_date_from: '',
  delivery_date_to: '',
});

// In the order the client listed them. `sort` is the server's sort key, where
// the column has one. `exportKey` is the display value an id column exports as.
const COLUMNS = [
  { key: 'rtv_no', label: 'RTV No', sort: 'rtv_no' },
  { key: 'po_id', label: 'Internal PO', sort: 'po_id' },
  { key: 'rtv_dn', label: 'RTV / DN' },
  { key: 'outward_tracking_id', label: 'Outward Tracking ID' },
  { key: 'outward_courier_name', label: 'Outward Channel Partner' },
  { key: 'bill_no', label: 'Bill No' },
  { key: 'po_qty', label: 'Qty' },
  { key: 'city', label: 'City', sort: 'city' },
  { key: 'status', label: 'Status', sort: 'status' },
  { key: 'inward_courier_id', label: 'Inward Channel Partner', exportKey: 'inward_courier_name' },
  { key: 'inward_tracking_id', label: 'Inward Tracking ID' },
  { key: 'delivered', label: 'Delivered' },
  { key: 'delivery_date', label: 'Delivery Date', sort: 'delivery_date' },
  { key: 'cn_number', label: 'Credit Note Number' },
  { key: 'cn_date', label: 'CN Date', sort: 'cn_date' },
  { key: 'checked_by', label: 'Checked Warehouse POC', exportKey: 'checked_by_name' },
  { key: 'updated_at', label: 'Last Updated', sort: 'updated_at' },
];

// Where the row came from, under its PO id: the whole shipment refused, or
// part of it short on receipt.
const sourceOf = (r) => (r.grn_status === 'Returned to Vendor'
  ? 'Returned to Vendor'
  : `Short ${r.discrepancy_qty ?? ''}`.trim());

const blank = (v) => v == null || String(v).trim() === '';
const cleanStr = (v) => (blank(v) ? null : String(v).trim());

export default function RTVList() {
  const { canEdit } = useRBAC();

  const [vendorTabs, setVendorTabs] = useState([]);
  const [vendorTab, setVendorTab] = useSessionState('rtv.vendorTab', 'Blinkit');
  const [filters, setFilters] = useSessionState('rtv.filters', defaultFilters);
  const [sort, setSort] = useSessionState('rtv.sort', { key: 'rtv_no', dir: 'desc' });
  const [page, setPage] = useSessionState('rtv.page', 1);
  const [pageSize, setPageSize] = useState(() => loadPersistedPageSize('rtv', 25));

  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [vendorCounts, setVendorCounts] = useState({});

  const [cities, setCities] = useState([]);
  const [couriers, setCouriers] = useState([]);
  const [checkers, setCheckers] = useState([]);
  const [edits, setEdits] = useState({});
  const [savingId, setSavingId] = useState(null);
  const [exporting, setExporting] = useState(false);
  // A Disposed save that would clear values waits here for the user to confirm.
  const [confirmDisposed, setConfirmDisposed] = useState(null);

  const activeCouriers = couriers.filter(c => c.is_active);

  const filterParams = useCallback((f) => {
    const params = {};
    Object.entries(f).forEach(([k, val]) => {
      if (k === 'status') {
        // Everything ticked is no filter at all; nothing ticked matches nothing.
        if (!Array.isArray(val) || val.length === STATUS_FILTER_OPTIONS.length) return;
        params.status = val.length ? val.join(',') : NONE_SELECTED;
        return;
      }
      if (String(val || '').trim()) params[k] = String(val).trim();
    });
    return params;
  }, []);

  const buildParams = useCallback((overrides = {}) => {
    const f = overrides.filters ?? filters;
    const s = overrides.sort ?? sort;
    return {
      page: overrides.page ?? page,
      page_size: overrides.pageSize ?? pageSize,
      sort_by: s.key,
      sort_dir: s.dir,
      vendor: overrides.vendor ?? vendorTab,
      ...filterParams(f),
    };
  }, [filters, sort, page, pageSize, vendorTab, filterParams]);

  const load = useCallback((overrides) => {
    setLoading(true);
    listRtv(buildParams(overrides))
      // Fresh rows drop any unsaved edits -- they were made against the old ones.
      .then(res => { setItems(res.rows || []); setTotal(res.total || 0); setEdits({}); })
      .catch(() => toast.error('Failed to load RTV data'))
      .finally(() => setLoading(false));
  }, [buildParams]);

  const loadCounts = useCallback((overrideFilters) => {
    getRtvCountsByVendor(filterParams(overrideFilters ?? filters))
      .then(res => setVendorCounts(res.counts || {}))
      .catch(() => {});
  }, [filters, filterParams]);

  useEffect(() => {
    load();
    loadCounts();
    listVendors()
      .then(rows => {
        const active = rows.filter(v => v.is_active).map(v => ({ key: v.name, label: v.name }));
        setVendorTabs(active);
        setVendorTab(curr => (active.some(t => t.key === curr) ? curr : (active[0]?.key || curr)));
      })
      .catch(() => {});
    listCities()
      .then(rows => setCities(sortByText(rows.filter(c => c.is_active).map(c => c.name))))
      .catch(() => {});
    listCouriers()
      .then(rows => setCouriers(sortByText(rows, c => c.name)))
      .catch(() => {});
    listUsersLite({ role: ROLES.WAREHOUSE_POC })
      .then(users => setCheckers(sortByText(users || [], u => u.name)))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setFilter = (k, v) => setFilters(f => ({ ...f, [k]: v }));
  const applySearch = () => { setPage(1); load({ page: 1 }); loadCounts(); };
  const clearFilters = () => {
    const f = defaultFilters();
    setFilters(f); setPage(1); load({ filters: f, page: 1 }); loadCounts(f);
  };
  const switchTab = (key) => { setVendorTab(key); setPage(1); load({ vendor: key, page: 1 }); };
  const toggleSort = (key) => {
    const next = sort.key === key ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' };
    setSort(next); setPage(1); load({ sort: next, page: 1 });
  };
  const handlePageChange = (p) => { setPage(p); load({ page: p }); };
  const handlePageSizeChange = (size) => {
    setPageSize(size); persistPageSize('rtv', size); setPage(1); load({ pageSize: size, page: 1 });
  };

  const valueOf = (r, key) => {
    const e = edits[r.id];
    return e && Object.prototype.hasOwnProperty.call(e, key) ? e[key] : r[key];
  };
  const setEdit = (id, patch) => setEdits(prev => ({ ...prev, [id]: { ...(prev[id] || {}), ...patch } }));
  const cancelEdit = (id) => setEdits(prev => { const n = { ...prev }; delete n[id]; return n; });
  const onKey = (id) => (e) => { if (e.key === 'Escape') cancelEdit(id); };

  // The row as it will save: stored status (not the derived one), with edits.
  const mergedRow = (r) => {
    const e = edits[r.id] || {};
    const base = {
      dn_number: r.dn_number, status: r.stored_status, inward_courier_id: r.inward_courier_id,
      inward_tracking_id: r.inward_tracking_id, delivered: r.delivered, delivery_date: r.delivery_date,
      cn_number: r.cn_number, cn_date: r.cn_date, checked_by: r.checked_by,
    };
    return { ...base, ...e };
  };

  const doSave = async (r, payload) => {
    setSavingId(r.id);
    try {
      await updateRtv(r.id, payload);
      toast.success(`Saved ${r.rtv_no}`);
      cancelEdit(r.id);
      load();
      loadCounts();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Save failed');
    } finally { setSavingId(null); }
  };

  const saveRow = (r) => {
    const e = edits[r.id];
    if (!e) return;
    const row = mergedRow(r);
    for (const k of ['delivery_date', 'cn_date']) {
      if (k in e && !blank(e[k]) && !isValidDateString(e[k])) {
        toast.error(`${k === 'cn_date' ? 'CN Date' : 'Delivery Date'} has an invalid year`);
        return;
      }
    }
    const err = rtvRowError(row);
    if (err) { toast.error(err); return; }

    const payload = {};
    for (const [k, v] of Object.entries(e)) {
      payload[k] = k === 'inward_courier_id' || k === 'checked_by'
        ? (blank(v) ? null : Number(v))
        : cleanStr(v);
    }
    // Disposed clears everything after Status. If any of it holds a value,
    // say so before it goes -- the history keeps the old values either way.
    if (row.status === DN_DISPOSED) {
      for (const f of AFTER_STATUS) payload[f] = null;
      const losing = AFTER_STATUS.filter(f => !blank(r[f]));
      if (losing.length && r.stored_status !== DN_DISPOSED) {
        const names = COLUMNS.filter(c => losing.includes(c.key)).map(c => c.label);
        setConfirmDisposed({ row: r, payload, names });
        return;
      }
    }
    doSave(r, payload);
  };

  const downloadXLSX = async () => {
    setExporting(true);
    try {
      const params = { ...buildParams(), page_size: 'all' };
      delete params.page;
      const res = await listRtv(params);
      const rows = res.rows || [];
      if (!rows.length) { toast('No records to export'); return; }
      const headers = COLUMNS.map(c => c.label);
      const data = rows.map(r => COLUMNS.map(c => {
        if (c.key === 'updated_at') return r.updated_at ? `${r.updated_by_name || ''} ${formatDateTime(r.updated_at)}`.trim() : '';
        const v = r[c.exportKey || c.key];
        return v == null ? '' : v;
      }));
      const ws = XLSX.utils.aoa_to_sheet([headers, ...data]);
      ws['!cols'] = headers.map(() => ({ wch: 20 }));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'RTV');
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
      XLSX.writeFile(wb, `rtv-${vendorTab.toLowerCase()}-${stamp}.xlsx`);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Export failed');
    } finally { setExporting(false); }
  };

  const inputCls = 'w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30';
  const cellCls = 'w-full px-2 py-1 border border-gray-200 rounded text-sm bg-white focus:outline-none focus:ring-1 focus:ring-[#c1121f]/40 disabled:bg-gray-100 disabled:text-gray-400';

  const SortIcon = ({ colKey }) => {
    if (sort.key !== colKey) return <ArrowUpDown size={12} className="text-gray-300" />;
    return sort.dir === 'asc'
      ? <ArrowUp size={12} className="text-[#c1121f]" />
      : <ArrowDown size={12} className="text-[#c1121f]" />;
  };

  const renderCell = (col, r) => {
    const row = mergedRow(r);
    const disposed = row.status === DN_DISPOSED;
    const k = onKey(r.id);
    const textInput = (field, extra = {}) => (
      <input
        type="text"
        value={valueOf(r, field) ?? ''}
        onChange={e => setEdit(r.id, { [field]: e.target.value })}
        onKeyDown={k}
        disabled={disposed}
        pattern="[A-Za-z0-9\-]*"
        className={`${cellCls} font-mono min-w-[9rem]`}
        {...extra}
      />
    );
    const dateInput = (field, disabled) => (
      <input
        type="date"
        value={valueOf(r, field) ?? ''}
        onChange={e => setEdit(r.id, { [field]: e.target.value })}
        onKeyDown={k}
        disabled={disabled}
        className={`${cellCls} min-w-[9rem]`}
      />
    );

    switch (col.key) {
      case 'rtv_no':
        return <span className="font-mono font-semibold text-[#003049] whitespace-nowrap">{r.rtv_no}</span>;
      case 'po_id':
        return (
          <span className="whitespace-nowrap">
            <span className="font-mono text-[#003049]">{r.po_id}</span>
            <span className="block text-[11px] text-gray-400">{sourceOf(r)}</span>
          </span>
        );
      case 'rtv_dn':
        // A discrepancy row's DN belongs to the GRN page. A fully returned
        // shipment has nowhere else to record one, so it is typed here.
        if (!blank(r.grn_dn) || !canEdit) return <span className="font-mono text-gray-700">{r.rtv_dn || '—'}</span>;
        return (
          <input
            type="text"
            value={valueOf(r, 'dn_number') ?? ''}
            onChange={e => setEdit(r.id, { dn_number: e.target.value })}
            onKeyDown={k}
            placeholder="—"
            pattern="[A-Za-z0-9\-]*"
            title="Returned to Vendor: the GRN page keeps no DN, so it is entered here"
            className={`${cellCls} font-mono min-w-[8rem]`}
          />
        );
      case 'outward_tracking_id':
      case 'bill_no':
        return <span className="font-mono text-gray-700 whitespace-nowrap">{r[col.key] || '—'}</span>;
      case 'outward_courier_name':
      case 'city':
        return <span className="text-gray-700 whitespace-nowrap">{r[col.key] || '—'}</span>;
      case 'po_qty':
        return <span className="text-gray-700">{r.po_qty ?? '—'}</span>;
      case 'status': {
        if (!canEdit) return r.status ? <Badge color={STATUS_COLORS[r.status] || 'gray'}>{r.status}</Badge> : <span className="text-gray-300">—</span>;
        // The select holds what is STORED. A row nobody has picked for shows
        // its derived status (DN - Yes when it has a DN) as the placeholder.
        const edited = edits[r.id] && 'status' in edits[r.id];
        const value = edited ? (edits[r.id].status ?? '') : (r.stored_status ?? '');
        return (
          <select
            value={value}
            onChange={e => setEdit(r.id, { status: e.target.value })}
            onKeyDown={k}
            className={`${cellCls} min-w-[10rem]`}
          >
            <option value="">{!edited && r.status && !r.stored_status ? `${r.status} (auto)` : '—'}</option>
            {RTV_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        );
      }
      case 'inward_courier_id': {
        if (!canEdit) return <span className="text-gray-700 whitespace-nowrap">{r.inward_courier_name || '—'}</span>;
        const current = valueOf(r, 'inward_courier_id');
        return (
          <select
            value={current ?? ''}
            onChange={e => setEdit(r.id, { inward_courier_id: e.target.value })}
            onKeyDown={k}
            disabled={disposed}
            className={`${cellCls} min-w-[10rem]`}
          >
            <option value="">—</option>
            {activeCouriers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            {/* Keep a since-deactivated courier on the row it was saved with. */}
            {r.inward_courier_id && !activeCouriers.some(c => c.id === r.inward_courier_id) && (
              <option value={r.inward_courier_id}>{r.inward_courier_name} (inactive)</option>
            )}
          </select>
        );
      }
      case 'inward_tracking_id':
        return canEdit ? textInput('inward_tracking_id') : <span className="font-mono text-gray-700">{r.inward_tracking_id || '—'}</span>;
      case 'delivered':
        if (!canEdit) return <span className="text-gray-700">{r.delivered || '—'}</span>;
        return (
          <select
            value={valueOf(r, 'delivered') ?? ''}
            onChange={e => {
              const v = e.target.value;
              // A delivery date only means something once the goods arrived.
              setEdit(r.id, v === 'Yes' ? { delivered: v } : { delivered: v, delivery_date: '' });
            }}
            onKeyDown={k}
            disabled={disposed}
            className={`${cellCls} min-w-[5rem]`}
          >
            <option value="">—</option>
            {DELIVERED_VALUES.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        );
      case 'delivery_date':
        return canEdit
          ? dateInput('delivery_date', disposed || row.delivered !== 'Yes')
          : <span className="text-gray-700 whitespace-nowrap">{r.delivery_date || '—'}</span>;
      case 'cn_number':
        return canEdit ? textInput('cn_number') : <span className="font-mono text-gray-700">{r.cn_number || '—'}</span>;
      case 'cn_date':
        return canEdit
          ? dateInput('cn_date', disposed)
          : <span className="text-gray-700 whitespace-nowrap">{r.cn_date || '—'}</span>;
      case 'checked_by':
        if (!canEdit) return <span className="text-gray-700 whitespace-nowrap">{r.checked_by_name || '—'}</span>;
        return (
          <select
            value={valueOf(r, 'checked_by') ?? ''}
            onChange={e => setEdit(r.id, { checked_by: e.target.value })}
            onKeyDown={k}
            disabled={disposed}
            className={`${cellCls} min-w-[10rem]`}
          >
            <option value="">—</option>
            {checkerOptionsFor(checkers, r.checked_by, r.checked_by_name).map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        );
      case 'updated_at':
        return r.updated_at ? (
          <span className="whitespace-nowrap text-xs">
            <span className="text-gray-700">{r.updated_by_name || '—'}</span>
            <span className="block text-gray-400">{formatDateTime(r.updated_at)}</span>
          </span>
        ) : '—';
      default:
        return r[col.key] ?? '—';
    }
  };

  return (
    <AppShell>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#003049]">RTV</h1>
          <p className="text-gray-500 text-sm">
            {total} return{total !== 1 ? 's' : ''} · {vendorTab} — POs returned to vendor or short on the GRN page
          </p>
        </div>
        <Button variant="outline" onClick={downloadXLSX} loading={exporting}>
          <Download size={16} />Download XLSX
        </Button>
      </div>

      <div className="flex gap-1 mb-4 border-b border-gray-200 overflow-x-auto">
        {vendorTabs.map(t => (
          <button
            key={t.key}
            type="button"
            onClick={() => switchTab(t.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px whitespace-nowrap transition-colors ${vendorTab === t.key ? 'border-[#c1121f] text-[#c1121f]' : 'border-transparent text-gray-500 hover:text-[#003049]'}`}
          >
            {t.label} <span className="ml-1 text-gray-400">({vendorCounts[t.key] ?? 0})</span>
          </button>
        ))}
      </div>

      <div className="bg-white border border-gray-200 rounded-xl p-4 mb-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Search</label>
            <input
              type="text"
              value={filters.q}
              onChange={e => setFilter('q', e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') applySearch(); }}
              placeholder="RTV no, PO, DN, tracking, CN…"
              className={inputCls}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Status</label>
            <MultiSelect
              options={STATUS_FILTER_OPTIONS}
              selected={filters.status}
              onChange={v => setFilter('status', v)}
              allLabel="All statuses"
              labelOf={statusFilterLabel}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">City</label>
            <select value={filters.city} onChange={e => setFilter('city', e.target.value)} className={inputCls}>
              <option value="">All cities</option>
              {cities.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Inward Channel Partner</label>
            <select value={filters.inward_courier_id} onChange={e => setFilter('inward_courier_id', e.target.value)} className={inputCls}>
              <option value="">All couriers</option>
              <option value="unassigned">Not set</option>
              {couriers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">CN Date From</label>
            <input type="date" value={filters.cn_date_from} onChange={e => setFilter('cn_date_from', e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">CN Date To</label>
            <input type="date" value={filters.cn_date_to} onChange={e => setFilter('cn_date_to', e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Delivery Date From</label>
            <input type="date" value={filters.delivery_date_from} onChange={e => setFilter('delivery_date_from', e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Delivery Date To</label>
            <input type="date" value={filters.delivery_date_to} onChange={e => setFilter('delivery_date_to', e.target.value)} className={inputCls} />
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
                    {col.sort ? (
                      <button type="button" onClick={() => toggleSort(col.sort)} className="inline-flex items-center gap-1 hover:text-[#003049]">
                        {col.label}<SortIcon colKey={col.sort} />
                      </button>
                    ) : col.label}
                  </th>
                ))}
                <th className="px-3 py-3 w-20 bg-gray-50" />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                [...Array(4)].map((_, i) => (
                  <tr key={i}>
                    <td colSpan={COLUMNS.length + 1} className="px-4 py-3">
                      <div className="h-4 bg-gray-100 rounded animate-pulse" />
                    </td>
                  </tr>
                ))
              ) : items.map(r => {
                const dirty = !!edits[r.id];
                return (
                  <tr key={r.id} className={`border-b border-gray-100 ${dirty ? DIRTY_ROW : 'hover:bg-gray-50'}`}>
                    {COLUMNS.map(col => (
                      <td key={col.key} className="px-3 py-2 align-top">{renderCell(col, r)}</td>
                    ))}
                    <td className="px-3 py-2 whitespace-nowrap align-top">
                      <div className="flex items-center gap-1">
                        {canEdit && dirty && (
                          <>
                            <button
                              type="button"
                              onClick={() => saveRow(r)}
                              disabled={savingId === r.id}
                              title="Save"
                              className="p-1.5 rounded bg-[#c1121f] text-white hover:bg-[#a01019] disabled:opacity-40"
                            >
                              <Save size={14} />
                            </button>
                            <button
                              type="button"
                              onClick={() => cancelEdit(r.id)}
                              title="Cancel (Esc)"
                              className="p-1.5 rounded text-gray-500 hover:bg-gray-100"
                            >
                              <X size={14} />
                            </button>
                          </>
                        )}
                        <HistoryButton entityType="rtv_return" entityId={r.id} title={`History — ${r.rtv_no}`} />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!loading && items.length === 0 && (
            <p className="text-center text-gray-400 py-8">No returns match the current filters</p>
          )}
        </div>
        <Pagination
          page={page}
          pageSize={pageSize}
          total={total}
          onPageChange={handlePageChange}
          onPageSizeChange={handlePageSizeChange}
          leftExtra={<Legend items={LEGEND} />}
        />
      </div>

      <ConfirmDialog
        isOpen={!!confirmDisposed}
        onClose={() => setConfirmDisposed(null)}
        onConfirm={() => {
          const { row, payload } = confirmDisposed;
          setConfirmDisposed(null);
          doSave(row, payload);
        }}
        title={`Mark ${confirmDisposed?.row.rtv_no || ''} as ${DN_DISPOSED}?`}
        message={confirmDisposed
          ? `Disposed goods are not coming back, so this clears ${confirmDisposed.names.join(', ')}. The history keeps the old values.`
          : ''}
        confirmLabel="Mark disposed"
        loading={savingId === confirmDisposed?.row.id}
      />
    </AppShell>
  );
}

