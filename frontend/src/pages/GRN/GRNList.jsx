import { useEffect, useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import * as XLSX from 'xlsx';
import { ArrowUp, ArrowDown, ArrowUpDown, Download, Save, X } from 'lucide-react';
import toast from 'react-hot-toast';
import AppShell from '../../components/layout/AppShell';
import Button from '../../components/ui/Button';
import Badge from '../../components/ui/Badge';
import Legend from '../../components/ui/Legend';
import Pagination, { loadPersistedPageSize, persistPageSize } from '../../components/ui/Pagination';
import { listOrderSummary, updateOrderSummary } from '../../api/orderSummary.api';
import { listCities } from '../../api/cities.api';
import { listCouriers } from '../../api/couriers.api';
import { formatDateTime } from '../../utils/formatters';
import { HistoryButton } from '../../components/shared/HistoryDrawer';

// Row highlight for rows with edits not yet saved (single source for row + legend).
const DIRTY_ROW = 'bg-amber-50/60';
const UNSAVED_LEGEND = [{ swatch: DIRTY_ROW, label: 'Unsaved changes' }];
import { useRBAC } from '../../hooks/useRBAC';

const VENDOR_TABS = [
  { key: 'Blinkit', label: 'Blinkit' },
  { key: 'Scootsy', label: 'Scootsy' },
  { key: 'Zepto',   label: 'Zepto' },
];

const GRN_STATUS_OPTIONS = [
  'Pending',
  'Out For Delivery',
  'Returned to Vendor',
  'Delivered - GRN Pending',
  'Delivered - GRN Received',
];
const STATUS_FILTER_OPTIONS = [
  'All',
  'Pending',
  'Yet to Dispatch',
  'Out For Delivery',
  'Returned to Vendor',
  'Delivered - GRN Pending',
  'Delivered - GRN Received',
];

const STATUS_COLORS = {
  'Yet to Dispatch':          'gray',
  'Pending':                  'blue',
  'Out For Delivery':         'orange',
  'Returned to Vendor':       'red',
  'Delivered - GRN Pending':  'yellow',
  'Delivered - GRN Received': 'green',
};

const defaultFilters = () => ({
  grn_status:             'Pending',
  appointment_date_from:  '',
  appointment_date_to:    '',
  city:                   '',
  courier_id:             '',
});

const seededFiltersFromURL = (params) => {
  const base = defaultFilters();
  if (!params) return base;
  for (const [k, v] of params.entries()) {
    if (k in base && v) base[k] = v;
  }
  return base;
};
const seededVendorTabFromURL = (params) => {
  const v = params?.get('vendor');
  return ['Blinkit', 'Scootsy', 'Zepto'].includes(v) ? v : 'Blinkit';
};

const buildColumns = (vendorTab) => [
  { key: 'po_date',             label: 'Builty Date' },
  { key: 'tracking_id',         label: 'Tracking' },
  { key: 'appointment_date',    label: 'Appointment Date' },
  ...(vendorTab === 'Zepto' ? [{ key: 'asn', label: 'ASN' }] : []),
  { key: 'computed_grn_status', label: 'Status' },
  { key: 'courier_name',        label: 'Courier' },
  { key: 'vendor_po_id',        label: 'PO Number' },
  { key: 'total_qty',           label: 'PO Qty' },
  { key: 'city',                label: 'City' },
  { key: 'po_expiry_date',      label: 'Expiry Date' },
  { key: 'grn_date',            label: 'GRN Date' },
  { key: 'grn_qty',             label: 'GRN Qty' },
  { key: 'grn_number',          label: 'GRN Number' },
  { key: 'discrepancy_qty',     label: 'Discrepancy Qty' },
  { key: 'discrepancy_number',  label: 'Discrepancy Number' },
  { key: 'note',                label: 'Note' },
];

export default function GRNList() {
  const { canEdit } = useRBAC();

  const [searchParams] = useSearchParams();
  const [vendorTab, setVendorTab] = useState(() => seededVendorTabFromURL(searchParams));
  const [filters, setFilters] = useState(() => seededFiltersFromURL(searchParams));
  const [sort, setSort] = useState({ key: 'updated_at', dir: 'desc' });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(() => loadPersistedPageSize('grn', 25));

  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const [cities, setCities] = useState([]);
  const [couriers, setCouriers] = useState([]);
  const activeCouriers = couriers.filter(c => c.is_active);
  const [edits, setEdits] = useState({});
  const [savingId, setSavingId] = useState(null);
  const [exporting, setExporting] = useState(false);

  const COLUMNS = buildColumns(vendorTab);

  const buildParams = useCallback((overrides = {}) => {
    const f = overrides.filters ?? filters;
    const v = overrides.vendor ?? vendorTab;
    const s = overrides.sort ?? sort;
    const p = overrides.page ?? page;
    const ps = overrides.pageSize ?? pageSize;
    const params = { page: p, page_size: ps, sort_by: s.key, sort_dir: s.dir, vendor: v };
    Object.entries(f).forEach(([k, val]) => {
      if (k === 'grn_status' && val === 'All') return;
      if (val) params[k] = val;
    });
    return params;
  }, [filters, vendorTab, sort, page, pageSize]);

  const load = useCallback((overrides) => {
    setLoading(true);
    listOrderSummary(buildParams(overrides))
      .then(res => { setItems(res.rows || []); setTotal(res.total || 0); })
      .catch(() => toast.error('Failed to load GRN data'))
      .finally(() => setLoading(false));
  }, [buildParams]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (searchParams.toString() === '') return;
    setFilters(seededFiltersFromURL(searchParams));
    setVendorTab(seededVendorTabFromURL(searchParams));
    setPage(1);
  }, [searchParams]);

  useEffect(() => {
    listCities()
      .then(rows => setCities(rows.filter(c => c.is_active).map(c => c.name)))
      .catch(() => {});
    listCouriers()
      .then(setCouriers)
      .catch(() => {});
  }, []);

  useEffect(() => { setEdits({}); }, [items]);

  const setFilter = (k, v) => setFilters(f => ({ ...f, [k]: v }));
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
    persistPageSize('grn', size);
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

  const isDispatched = (po) => po.status === 'Closed';

  const saveRow = async (po) => {
    const e = edits[po.po_id];
    if (!e) return;
    const nextGrnStatus = 'grn_status' in e ? e.grn_status : po.grn_status;
    const nextGrnDate   = 'grn_date' in e ? e.grn_date : po.grn_date;
    const nextGrnQty    = 'grn_qty' in e ? e.grn_qty : po.grn_qty;
    const nextDiscQty   = 'discrepancy_qty' in e ? e.discrepancy_qty : po.discrepancy_qty;
    const nextGrnNo     = 'grn_number' in e ? e.grn_number : po.grn_number;
    const nextDiscNo    = 'discrepancy_number' in e ? e.discrepancy_number : po.discrepancy_number;

    if (nextGrnStatus === 'Delivered - GRN Received') {
      const poQty = Number(po.total_qty || 0);
      const gq = nextGrnQty == null || nextGrnQty === '' ? null : Number(nextGrnQty);
      const dq = nextDiscQty == null || nextDiscQty === '' ? null : Number(nextDiscQty);
      if (!String(nextGrnDate || '').trim()) {
        return toast.error('GRN Date is required');
      }
      if (gq == null || dq == null) {
        return toast.error('GRN Qty and Discrepancy Qty are required');
      }
      if (gq + dq !== poQty) {
        return toast.error(`GRN Qty + Discrepancy Qty must equal PO Qty (${poQty})`);
      }
      if (!String(nextGrnNo || '').trim()) {
        return toast.error('GRN Number is required');
      }
      if (dq > 0 && !String(nextDiscNo || '').trim()) {
        return toast.error('Discrepancy Number is required when Discrepancy Qty > 0');
      }
    }

    setSavingId(po.po_id);
    try {
      const payload = {};
      const cleanInt = (v) => v == null || v === '' ? null : Number(v);
      const cleanStr = (v) => v == null || String(v).trim() === '' ? null : String(v).trim();
      if ('appointment_date'   in e) payload.appointment_date   = cleanStr(e.appointment_date);
      if ('asn'                in e) payload.asn                = cleanStr(e.asn);
      if ('grn_status'         in e) payload.grn_status         = cleanStr(e.grn_status);
      if ('grn_date'           in e) payload.grn_date           = cleanStr(e.grn_date);
      if ('grn_qty'            in e) payload.grn_qty            = cleanInt(e.grn_qty);
      if ('grn_number'         in e) payload.grn_number         = cleanStr(e.grn_number);
      if ('discrepancy_qty'    in e) payload.discrepancy_qty    = cleanInt(e.discrepancy_qty);
      if ('discrepancy_number' in e) payload.discrepancy_number = cleanStr(e.discrepancy_number);
      if ('note'               in e) payload.note               = cleanStr(e.note);
      await updateOrderSummary(po.po_id, payload);
      toast.success(`Saved ${po.po_id}`);
      cancelEdit(po.po_id);
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Save failed');
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
      XLSX.utils.book_append_sheet(wb, ws, 'GRN');
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
      XLSX.writeFile(wb, `grn-${vendorTab.toLowerCase()}-${stamp}.xlsx`);
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
          <h1 className="text-2xl font-bold text-[#003049]">GRN</h1>
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
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Status</label>
            <select value={filters.grn_status} onChange={e => setFilter('grn_status', e.target.value)} className={inputCls}>
              {STATUS_FILTER_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Appointment From</label>
            <input type="date" value={filters.appointment_date_from} onChange={e => setFilter('appointment_date_from', e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Appointment To</label>
            <input type="date" value={filters.appointment_date_to} onChange={e => setFilter('appointment_date_to', e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">City</label>
            <select value={filters.city} onChange={e => setFilter('city', e.target.value)} className={inputCls}>
              <option value="">All cities</option>
              {cities.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
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
        <div className="flex justify-end gap-2 mt-3">
          <Button variant="ghost" onClick={clearFilters}>Clear</Button>
          <Button variant="outline" onClick={applySearch}>Search</Button>
        </div>
      </div>

      <Legend items={UNSAVED_LEGEND} className="mb-2" />

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
                const dispatched = isDispatched(po);
                const editAppt    = valueOf(po, 'appointment_date') ?? '';
                const editAsn     = valueOf(po, 'asn') ?? '';
                const editStatus  = valueOf(po, 'grn_status') ?? '';
                const editGrnDate = valueOf(po, 'grn_date') ?? '';
                const editGrnQty  = valueOf(po, 'grn_qty');
                const editGrnNo   = valueOf(po, 'grn_number') ?? '';
                const editDiscQty = valueOf(po, 'discrepancy_qty');
                const editDiscNo  = valueOf(po, 'discrepancy_number') ?? '';
                const editNote    = valueOf(po, 'note') ?? '';
                const displayStatus = editStatus || po.computed_grn_status;
                const isDGR = displayStatus === 'Delivered - GRN Received';
                const discQtyNum = editDiscQty == null || editDiscQty === '' ? 0 : Number(editDiscQty);
                const onKey = onCellKeyDown(po.po_id);
                return (
                  <tr key={po.po_id} className={`border-b border-gray-100 ${dirty ? DIRTY_ROW : 'hover:bg-gray-50'}`}>
                    {COLUMNS.map(col => {
                      switch (col.key) {
                        case 'po_date':
                        case 'po_expiry_date':
                          return <td key={col.key} className="px-3 py-2 text-gray-700 whitespace-nowrap">{po[col.key] || '—'}</td>;
                        case 'tracking_id':
                          return <td key={col.key} className="px-3 py-2 text-gray-700 font-mono whitespace-nowrap">{po.tracking_id || '—'}</td>;
                        case 'appointment_date':
                          return (
                            <td key={col.key} className="px-3 py-2">
                              {canEdit && dispatched ? (
                                <input
                                  type="date"
                                  value={editAppt || ''}
                                  onChange={e => setEdit(po.po_id, { appointment_date: e.target.value })}
                                  onKeyDown={onKey}
                                  className={cellCls}
                                />
                              ) : (
                                <span className="text-gray-700">{po.appointment_date || '—'}</span>
                              )}
                            </td>
                          );
                        case 'asn':
                          return (
                            <td key={col.key} className="px-3 py-2">
                              {canEdit ? (
                                <input
                                  type="text"
                                  value={editAsn}
                                  onChange={e => setEdit(po.po_id, { asn: e.target.value })}
                                  onKeyDown={onKey}
                                  placeholder="—"
                                  className={`${cellCls} font-mono`}
                                />
                              ) : (
                                <span className="text-gray-700 font-mono">{po.asn || '—'}</span>
                              )}
                            </td>
                          );
                        case 'computed_grn_status':
                          return (
                            <td key={col.key} className="px-3 py-2">
                              {canEdit && dispatched ? (
                                <select
                                  value={editStatus || po.grn_status || 'Pending'}
                                  onChange={e => {
                                    const v = e.target.value;
                                    const patch = { grn_status: v };
                                    if (v !== 'Delivered - GRN Received') {
                                      // Clear DGR-only fields when leaving that state
                                      patch.grn_date = '';
                                      patch.grn_qty = '';
                                      patch.grn_number = '';
                                      patch.discrepancy_qty = '';
                                      patch.discrepancy_number = '';
                                    }
                                    setEdit(po.po_id, patch);
                                  }}
                                  onKeyDown={onKey}
                                  className={cellCls}
                                >
                                  {GRN_STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
                                </select>
                              ) : (
                                <Badge color={STATUS_COLORS[po.computed_grn_status] || 'gray'}>{po.computed_grn_status || '—'}</Badge>
                              )}
                            </td>
                          );
                        case 'courier_name':
                          return <td key={col.key} className="px-3 py-2 text-gray-700 whitespace-nowrap">{po.courier_name || '—'}</td>;
                        case 'vendor_po_id':
                          return <td key={col.key} className="px-3 py-2 font-mono text-gray-700 whitespace-nowrap">{po.vendor_po_id || '—'}</td>;
                        case 'total_qty':
                          return <td key={col.key} className="px-3 py-2 font-semibold text-gray-800">{po.total_qty ?? 0}</td>;
                        case 'city':
                          return <td key={col.key} className="px-3 py-2 text-gray-600 whitespace-nowrap">{po.city || '—'}</td>;
                        case 'grn_date':
                          return (
                            <td key={col.key} className="px-3 py-2">
                              {canEdit && isDGR ? (
                                <input
                                  type="date"
                                  value={editGrnDate || ''}
                                  onChange={e => setEdit(po.po_id, { grn_date: e.target.value })}
                                  onKeyDown={onKey}
                                  className={cellCls}
                                />
                              ) : (
                                <span className="text-gray-700">{po.grn_date || '—'}</span>
                              )}
                            </td>
                          );
                        case 'grn_qty':
                          return (
                            <td key={col.key} className="px-3 py-2">
                              {canEdit && isDGR ? (
                                <input
                                  type="number"
                                  min={0}
                                  value={editGrnQty ?? ''}
                                  onChange={e => setEdit(po.po_id, { grn_qty: e.target.value })}
                                  onKeyDown={onKey}
                                  className={cellCls}
                                />
                              ) : (
                                <span className="text-gray-700">{po.grn_qty ?? '—'}</span>
                              )}
                            </td>
                          );
                        case 'grn_number':
                          return (
                            <td key={col.key} className="px-3 py-2">
                              {canEdit && isDGR ? (
                                <input
                                  type="text"
                                  value={editGrnNo}
                                  onChange={e => setEdit(po.po_id, { grn_number: e.target.value })}
                                  onKeyDown={onKey}
                                  placeholder="—"
                                  pattern="[A-Za-z0-9-]*"
                                  className={`${cellCls} font-mono`}
                                />
                              ) : (
                                <span className="text-gray-700 font-mono">{po.grn_number || '—'}</span>
                              )}
                            </td>
                          );
                        case 'discrepancy_qty':
                          return (
                            <td key={col.key} className="px-3 py-2">
                              {canEdit && isDGR ? (
                                <input
                                  type="number"
                                  min={0}
                                  value={editDiscQty ?? ''}
                                  onChange={e => {
                                    const v = e.target.value;
                                    const patch = { discrepancy_qty: v };
                                    // Clear discrepancy_number when qty drops to 0
                                    if (v === '' || Number(v) === 0) patch.discrepancy_number = '';
                                    setEdit(po.po_id, patch);
                                  }}
                                  onKeyDown={onKey}
                                  className={cellCls}
                                />
                              ) : (
                                <span className="text-gray-700">{po.discrepancy_qty ?? '—'}</span>
                              )}
                            </td>
                          );
                        case 'discrepancy_number':
                          return (
                            <td key={col.key} className="px-3 py-2">
                              {canEdit && isDGR ? (
                                <input
                                  type="text"
                                  value={editDiscNo}
                                  disabled={discQtyNum <= 0}
                                  onChange={e => setEdit(po.po_id, { discrepancy_number: e.target.value })}
                                  onKeyDown={onKey}
                                  placeholder={discQtyNum > 0 ? '—' : 'n/a'}
                                  pattern="[A-Za-z0-9-]*"
                                  className={`${cellCls} font-mono`}
                                />
                              ) : (
                                <span className="text-gray-700 font-mono">{po.discrepancy_number || '—'}</span>
                              )}
                            </td>
                          );
                        case 'note':
                          return (
                            <td key={col.key} className="px-3 py-2">
                              {canEdit ? (
                                <input
                                  type="text"
                                  value={editNote}
                                  onChange={e => setEdit(po.po_id, { note: e.target.value })}
                                  onKeyDown={onKey}
                                  placeholder="Add a comment..."
                                  className={cellCls}
                                />
                              ) : (
                                <span className="text-gray-700">{po.note || '—'}</span>
                              )}
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
    </AppShell>
  );
}
