import { useEffect, useState, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import * as XLSX from 'xlsx';
import { ArrowUp, ArrowDown, ArrowUpDown, Download, Save, X, ChevronDown, ChevronLeft, ChevronRight, Calendar as CalendarIcon } from 'lucide-react';
import toast from 'react-hot-toast';
import AppShell from '../../components/layout/AppShell';
import Button from '../../components/ui/Button';
import Badge from '../../components/ui/Badge';
import Legend from '../../components/ui/Legend';
import Pagination, { loadPersistedPageSize, persistPageSize } from '../../components/ui/Pagination';
import { useSessionState } from '../../hooks/useSessionState';
import { listOrderSummary, updateOrderSummary, getGrnAppointmentCounts, getOrderSummaryCountsByVendor } from '../../api/orderSummary.api';
import { listVendors } from '../../api/vendors.api';
import { listCities } from '../../api/cities.api';
import { listCouriers } from '../../api/couriers.api';
import { sortByText } from '../../utils/sort';
import { usesPickupDate } from '../../utils/pickupDate';
import { HistoryButton } from '../../components/shared/HistoryDrawer';

// Row highlight for rows with edits not yet saved (single source for row + legend).
const DIRTY_ROW = 'bg-amber-50/60';
const UNSAVED_LEGEND = [{ swatch: DIRTY_ROW, label: 'Unsaved changes' }];
import { useRBAC } from '../../hooks/useRBAC';

const GRN_STATUS_OPTIONS = [
  'Pending',
  'Out For Delivery',
  'Returned to Vendor',
  'Delivered - GRN Pending',
  'Delivered - GRN Received',
];
// Selectable values for the multiselect status filter (includes the computed
// 'Yet to Dispatch'). Default selection is the active in-flight pipeline:
// 'Returned to Vendor' and the fully-closed 'Delivered - GRN Received' are left
// out of the initial view (the user can still select them).
const STATUS_MULTI_OPTIONS = [
  'Yet to Dispatch',
  'Pending',
  'Out For Delivery',
  'Returned to Vendor',
  'Delivered - GRN Pending',
  'Delivered - GRN Received',
];
const DEFAULT_STATUS_SELECTION = [
  'Yet to Dispatch',
  'Pending',
  'Out For Delivery',
  'Delivered - GRN Pending',
];

const STATUS_COLORS = {
  'Yet to Dispatch':          'gray',
  'Pending':                  'blue',
  'Out For Delivery':         'orange',
  'Returned to Vendor':       'red',
  'Delivered - GRN Pending':  'yellow',
  'Delivered - GRN Received': 'green',
};

// ── date helpers (no date lib in the project; native Date, local time) ──
const isoLocal = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};
const parseISO = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (iso, n) => { const d = parseISO(iso); d.setDate(d.getDate() + n); return isoLocal(d); };
const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// The GRN view opens with no appointment-date filter (shows all dates). The user
// narrows by date via the date navigator or the Today/Yesterday quick buttons.
const defaultFilters = () => {
  return {
    grn_status:             [...DEFAULT_STATUS_SELECTION],
    appointment_date_from:  '',
    appointment_date_to:    '',
    city:                   '',
    courier_id:             '',
  };
};

const seededFiltersFromURL = (params) => {
  const base = defaultFilters();
  if (!params) return base;
  for (const [k, v] of params.entries()) {
    if (!(k in base) || !v) continue;
    if (k === 'grn_status') base[k] = v.split(',').map(s => s.trim()).filter(Boolean);
    else base[k] = v;
  }
  return base;
};
const seededVendorTabFromURL = (params) => {
  const v = params?.get('vendor');
  // Accept any vendor passed in the URL; the active-vendor list loads async and
  // reconciles the tab afterwards. Default to Blinkit when none is given.
  return v ? v : 'Blinkit';
};

// True when the URL carries a filter or vendor value (deep link). A bare
// navigate-back has none, so the session-restored state is kept instead.
const urlHasFilters = (params) => {
  if (!params) return false;
  if (params.get('vendor')) return true;
  return Object.keys(defaultFilters()).some(k => params.get(k));
};

// Vendors whose appointment carries an extra reference next to the appointment
// date: Zepto uses an ASN, Now/Blinkit use an Appointment ID. Whichever applies
// is mandatory once an appointment date is set (enforced on save + in the API).
const ASN_VENDORS = ['Zepto'];
const APPOINTMENT_ID_VENDORS = ['Now', 'Blinkit'];
const DELIVERY_CODE_VENDORS = ['Now'];

const buildColumns = (vendorTab) => [
  { key: 'dispatch_date',       label: 'Builty Date' },
  { key: 'tracking_id',         label: 'Tracking' },
  { key: 'appointment_date',    label: 'Appointment Date' },
  ...(ASN_VENDORS.includes(vendorTab) ? [{ key: 'asn', label: 'ASN' }] : []),
  ...(APPOINTMENT_ID_VENDORS.includes(vendorTab) ? [{ key: 'appointment_id', label: 'Appointment ID' }] : []),
  { key: 'computed_grn_status', label: 'Status' },
  { key: 'courier_name',        label: 'Courier' },
  { key: 'po_id',               label: 'PO ID' },
  { key: 'vendor_po_id',        label: 'PO Number' },
  { key: 'total_qty',           label: 'PO Qty' },
  { key: 'city',                label: 'City' },
  ...(DELIVERY_CODE_VENDORS.includes(vendorTab) ? [{ key: 'delivery_code', label: 'Delivery Code' }] : []),
  { key: 'expiry_or_pickup',    label: usesPickupDate(vendorTab) ? 'Pickup Date' : 'Expiry Date' },
  { key: 'grn_date',            label: 'GRN Date' },
  { key: 'grn_qty',             label: 'GRN Qty' },
  { key: 'grn_number',          label: 'GRN Number' },
  { key: 'discrepancy_qty',     label: 'Discrepancy Qty' },
  { key: 'discrepancy_number',  label: 'Discrepancy Number' },
  { key: 'note',                label: 'Note' },
];

// `‹ Today ›` appointment-date navigator with a calendar popover. The calendar
// shows a per-day appointment-count badge for the current vendor tab. Picking a
// day (arrows or grid) calls onPick(iso) — '' clears the date filter.
function AppointmentDateNav({ vendor, value, onPick }) {
  const today = isoLocal(new Date());
  const current = value || today;
  const [open, setOpen] = useState(false);
  const [viewMonth, setViewMonth] = useState(() => { const d = parseISO(current); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const [counts, setCounts] = useState({});

  // Fetch month counts when the popover opens or the month/vendor changes.
  useEffect(() => {
    if (!open) return;
    const first = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1);
    const last = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 0);
    getGrnAppointmentCounts(vendor, isoLocal(first), isoLocal(last))
      .then(res => {
        const map = {};
        (res.rows || []).forEach(r => {
          map[r.appointment_date] = { count: Number(r.count) || 0, pending: Number(r.pending) || 0 };
        });
        setCounts(map);
      })
      .catch(() => setCounts({}));
  }, [open, viewMonth, vendor]);

  // Close the calendar popover on any click outside it.
  const popRef = useRef(null);
  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (popRef.current && !popRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const label = value ? (value === today ? `Today · ${value}` : value) : 'All dates';
  const pick = (iso) => { onPick(iso); setOpen(false); };

  const startPad = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1).getDay();
  const daysInMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < startPad; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(viewMonth.getFullYear(), viewMonth.getMonth(), d));

  return (
    <div className="flex items-center gap-2">
      <button type="button" onClick={() => onPick(addDays(current, -1))} title="Previous day" className="p-1.5 rounded border border-gray-200 hover:bg-gray-50 text-gray-600"><ChevronLeft size={16} /></button>
      <div className="relative" ref={popRef}>
        <button type="button" onClick={() => setOpen(o => !o)} className="min-w-[160px] px-3 py-1.5 rounded border border-gray-200 bg-white text-sm font-medium text-[#003049] hover:bg-gray-50 inline-flex items-center gap-2 justify-center">
          <CalendarIcon size={14} className="text-gray-400" />{label}
        </button>
        {open && (
          <div className="absolute z-30 mt-1 left-1/2 -translate-x-1/2 w-72 max-w-[calc(100vw-1rem)] bg-white border border-gray-200 rounded-lg shadow-lg p-3">
            <div className="flex items-center justify-between mb-2">
              <button type="button" onClick={() => setViewMonth(m => new Date(m.getFullYear(), m.getMonth() - 1, 1))} className="p-1 rounded hover:bg-gray-100"><ChevronLeft size={16} /></button>
              <span className="text-sm font-semibold text-[#003049]">{MONTHS[viewMonth.getMonth()]} {viewMonth.getFullYear()}</span>
              <button type="button" onClick={() => setViewMonth(m => new Date(m.getFullYear(), m.getMonth() + 1, 1))} className="p-1 rounded hover:bg-gray-100"><ChevronRight size={16} /></button>
            </div>
            <div className="grid grid-cols-7 gap-1 text-center text-[11px] text-gray-400 mb-1">
              {WEEKDAYS.map(w => <div key={w}>{w}</div>)}
            </div>
            <div className="grid grid-cols-7 gap-1">
              {cells.map((d, i) => {
                if (!d) return <div key={i} />;
                const iso = isoLocal(d);
                const info = counts[iso];
                const cnt = info?.count || 0;
                const pending = info?.pending || 0;
                const isSel = iso === value;
                const isToday = iso === today;
                // Red only when it needs attention: a today/past day with GRN still
                // pending. Otherwise the count is shown in calm brand navy.
                const overduePending = pending > 0 && iso <= today;
                // On a selected (red) cell, use a white fill with a coloured ring so
                // the badge stays legible against the red background.
                const badgeCls = isSel
                  ? `bg-white ring-1 ${overduePending ? 'ring-[#c1121f] text-[#c1121f]' : 'ring-[#003049] text-[#003049]'}`
                  : `text-white ${overduePending ? 'bg-[#c1121f]' : 'bg-[#003049]'}`;
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => pick(iso)}
                    className={`relative h-9 rounded text-sm flex items-center justify-center ${isSel ? 'bg-[#c1121f] text-white' : isToday ? 'bg-amber-50 text-[#003049]' : 'hover:bg-gray-100 text-gray-700'}`}
                  >
                    {d.getDate()}
                    {cnt > 0 && (
                      <span className={`absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 rounded-full text-[11px] font-bold leading-none flex items-center justify-center shadow-sm ${badgeCls}`} title={overduePending ? `${cnt} appointment${cnt !== 1 ? 's' : ''} · ${pending} pending GRN` : `${cnt} appointment${cnt !== 1 ? 's' : ''}`}>{cnt}</span>
                    )}
                  </button>
                );
              })}
            </div>
            <div className="flex justify-between mt-2 pt-2 border-t border-gray-100">
              <button type="button" onClick={() => pick(today)} className="text-xs text-[#c1121f] hover:underline">Today</button>
              {value && <button type="button" onClick={() => { onPick(''); setOpen(false); }} className="text-xs text-gray-500 hover:underline">Clear date</button>}
            </div>
          </div>
        )}
      </div>
      <button type="button" onClick={() => onPick(addDays(current, 1))} title="Next day" className="p-1.5 rounded border border-gray-200 hover:bg-gray-50 text-gray-600"><ChevronRight size={16} /></button>
    </div>
  );
}

// Checkbox dropdown for the multi-value status filter. Native <details>, but
// closed on any click outside the control.
function StatusMultiSelect({ selected, onChange }) {
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
    <details ref={detRef} className="relative">
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

export default function GRNList() {
  const { canEdit } = useRBAC();

  const [searchParams] = useSearchParams();
  const [vendorTabs, setVendorTabs] = useState([]);
  const [vendorTab, setVendorTab] = useSessionState('grn.vendorTab', 'Blinkit');
  const [filters, setFilters] = useSessionState('grn.filters', defaultFilters);
  const [sort, setSort] = useSessionState('grn.sort', { key: 'updated_at', dir: 'desc' });
  const [page, setPage] = useSessionState('grn.page', 1);
  const [pageSize, setPageSize] = useState(() => loadPersistedPageSize('grn', 25));

  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [vendorCounts, setVendorCounts] = useState({});

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
      if (k === 'grn_status') {
        // Empty selection = no status filter (show all). Otherwise comma-join.
        if (Array.isArray(val) && val.length) params[k] = val.join(',');
        return;
      }
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

  // Per-vendor row counts shown beside each tab name. Honors the current filter
  // set (grn_status array → comma-join) so each tab's count matches its content.
  const loadCounts = useCallback((overrideFilters) => {
    const f = overrideFilters ?? filters;
    const params = {};
    Object.entries(f).forEach(([k, val]) => {
      if (k === 'grn_status') {
        if (Array.isArray(val) && val.length) params[k] = val.join(',');
        return;
      }
      if (val) params[k] = val;
    });
    getOrderSummaryCountsByVendor(params)
      .then(res => setVendorCounts(res.counts || {}))
      .catch(() => {});
  }, [filters]);

  // Load on mount and whenever the URL (navigation) changes. Editing filter inputs
  // does NOT fetch — only an explicit action (Search/Clear/tab/sort/pagination)
  // does. We pass the seeded values as overrides so the fetch doesn't race the
  // async setState.
  // A deep link with filter/vendor params wins; a bare navigate-back keeps the
  // state restored from sessionStorage instead of resetting to defaults.
  useEffect(() => {
    if (urlHasFilters(searchParams)) {
      const f = seededFiltersFromURL(searchParams);
      const v = seededVendorTabFromURL(searchParams);
      setFilters(f);
      setVendorTab(v);
      setPage(1);
      load({ filters: f, vendor: v, page: 1 });
      loadCounts(f);
    } else {
      load({ filters, vendor: vendorTab, page });
      loadCounts(filters);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  useEffect(() => {
    listVendors()
      .then(rows => {
        const active = rows.filter(v => v.is_active).map(v => ({ key: v.name, label: v.name }));
        setVendorTabs(active);
        // Reconcile the current tab against the loaded vendor list (e.g. a stale
        // URL vendor) by falling back to the first available vendor.
        setVendorTab(curr => (active.some(t => t.key === curr) ? curr : (active[0]?.key || curr)));
      })
      .catch(() => {});
    listCities()
      .then(rows => setCities(sortByText(rows.filter(c => c.is_active).map(c => c.name))))
      .catch(() => {});
    listCouriers()
      .then(rows => setCouriers(sortByText(rows, c => c.name)))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { setEdits({}); }, [items]);

  const setFilter = (k, v) => setFilters(f => ({ ...f, [k]: v }));
  const applySearch = () => { setPage(1); load({ page: 1 }); loadCounts(); };
  const clearFilters = () => { const f = defaultFilters(); setFilters(f); setPage(1); load({ filters: f, page: 1 }); loadCounts(f); };

  // The date navigator sets a single appointment day (from = to) and loads
  // immediately — it's a navigation control, not one of the Search-button filters.
  const apptValue = (filters.appointment_date_from && filters.appointment_date_from === filters.appointment_date_to)
    ? filters.appointment_date_from
    : '';
  const pickAppointmentDay = (iso) => {
    const f = { ...filters, appointment_date_from: iso || '', appointment_date_to: iso || '' };
    setFilters(f);
    setPage(1);
    load({ filters: f, page: 1 });
    loadCounts(f);
  };

  // Today/Yesterday quick buttons: show ALL POs for that appointment day,
  // ignoring status and any other applied filters (all statuses selected,
  // city/courier cleared).
  const pickApptDayAllFilters = (iso) => {
    const f = {
      grn_status:            [...STATUS_MULTI_OPTIONS],
      appointment_date_from: iso,
      appointment_date_to:   iso,
      city:                  '',
      courier_id:            '',
    };
    setFilters(f);
    setPage(1);
    load({ filters: f, page: 1 });
    loadCounts(f);
  };

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
    const nextAppt      = 'appointment_date' in e ? e.appointment_date : po.appointment_date;
    const nextAsn       = 'asn' in e ? e.asn : po.asn;
    const nextApptId    = 'appointment_id' in e ? e.appointment_id : po.appointment_id;

    // Once an appointment date is set, the vendor's companion reference is required —
    // but only enforce when this save actually touches an appointment field, so
    // unrelated edits on legacy rows (appointment date but no companion) still save.
    const touchesAppt = 'appointment_date' in e || 'asn' in e || 'appointment_id' in e;
    if (touchesAppt && String(nextAppt || '').trim()) {
      if (ASN_VENDORS.includes(po.vendor) && !String(nextAsn || '').trim()) {
        return toast.error('ASN is required once an appointment date is set');
      }
      if (APPOINTMENT_ID_VENDORS.includes(po.vendor) && !String(nextApptId || '').trim()) {
        return toast.error('Appointment ID is required once an appointment date is set');
      }
    }

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
      if ('appointment_id'     in e) payload.appointment_id     = cleanStr(e.appointment_id);
      if ('grn_status'         in e) payload.grn_status         = cleanStr(e.grn_status);
      if ('grn_date'           in e) payload.grn_date           = cleanStr(e.grn_date);
      if ('grn_qty'            in e) payload.grn_qty            = cleanInt(e.grn_qty);
      if ('grn_number'         in e) payload.grn_number         = cleanStr(e.grn_number);
      if ('discrepancy_qty'    in e) payload.discrepancy_qty    = cleanInt(e.discrepancy_qty);
      if ('discrepancy_number' in e) payload.discrepancy_number = cleanStr(e.discrepancy_number);
      if ('note'               in e) payload.note               = cleanStr(e.note);
      if ('delivery_code'      in e) payload.delivery_code      = cleanStr(e.delivery_code);
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
  // GRN status labels are long (e.g. "Delivered - GRN Received"): give the in-cell
  // dropdown a min-width so the value stays readable; the table scrolls instead.
  const cellSelectCls = `${cellCls} min-w-[13rem]`;
  // Notes are free text and can run long: widen the cell and clip with an
  // ellipsis rather than letting the row grow or the text wrap.
  const cellNoteCls = `${cellCls} min-w-[16rem] truncate`;

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
        {vendorTabs.map(t => (
          <button
            key={t.key}
            type="button"
            onClick={() => switchTab(t.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${vendorTab === t.key ? 'border-[#c1121f] text-[#c1121f]' : 'border-transparent text-gray-500 hover:text-[#003049]'}`}
          >
            {t.label} <span className="ml-1 text-gray-400">({vendorCounts[t.key] ?? 0})</span>
          </button>
        ))}
      </div>

      <div className="bg-white border border-gray-200 rounded-xl p-4 mb-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Status</label>
            <StatusMultiSelect selected={filters.grn_status} onChange={v => setFilter('grn_status', v)} />
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

      <div className="mb-2 flex items-center gap-2 flex-wrap">
        <AppointmentDateNav vendor={vendorTab} value={apptValue} onPick={pickAppointmentDay} />
        {[
          { label: 'Today', iso: isoLocal(new Date()) },
          { label: 'Yesterday', iso: addDays(isoLocal(new Date()), -1) },
        ].map(({ label, iso }) => {
          const active = apptValue === iso;
          return (
            <button
              key={label}
              type="button"
              onClick={() => pickApptDayAllFilters(iso)}
              className={`px-3 py-1.5 rounded border text-sm font-medium ${active ? 'bg-[#c1121f] text-white border-[#c1121f]' : 'border-gray-200 bg-white text-[#003049] hover:bg-gray-50'}`}
            >
              {label}
            </button>
          );
        })}
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
                const dispatched = isDispatched(po);
                const editAppt    = valueOf(po, 'appointment_date') ?? '';
                const editAsn     = valueOf(po, 'asn') ?? '';
                const editApptId  = valueOf(po, 'appointment_id') ?? '';
                const editStatus  = valueOf(po, 'grn_status') ?? '';
                const editGrnDate = valueOf(po, 'grn_date') ?? '';
                const editGrnQty  = valueOf(po, 'grn_qty');
                const editGrnNo   = valueOf(po, 'grn_number') ?? '';
                const editDiscQty = valueOf(po, 'discrepancy_qty');
                const editDiscNo  = valueOf(po, 'discrepancy_number') ?? '';
                const editNote    = valueOf(po, 'note') ?? '';
                const editDeliveryCode = valueOf(po, 'delivery_code') ?? '';
                const displayStatus = editStatus || po.computed_grn_status;
                const isDGR = displayStatus === 'Delivered - GRN Received';
                const discQtyNum = editDiscQty == null || editDiscQty === '' ? 0 : Number(editDiscQty);
                const onKey = onCellKeyDown(po.po_id);
                return (
                  <tr key={po.po_id} className={`border-b border-gray-100 ${dirty ? DIRTY_ROW : 'hover:bg-gray-50'}`}>
                    {COLUMNS.map(col => {
                      switch (col.key) {
                        case 'dispatch_date':
                        case 'expiry_or_pickup':
                          return <td key={col.key} className="px-3 py-2 text-gray-700 whitespace-nowrap">{po[col.key] || '—'}</td>;
                        case 'tracking_id':
                          return <td key={col.key} className="px-3 py-2 text-gray-700 font-mono whitespace-nowrap">{po.tracking_id || '—'}</td>;
                        case 'appointment_date':
                          return (
                            <td key={col.key} className="px-3 py-2">
                              {canEdit && (dispatched || po.vendor === 'Minutes') ? (
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
                        case 'appointment_id':
                          return (
                            <td key={col.key} className="px-3 py-2">
                              {canEdit ? (
                                <input
                                  type="text"
                                  value={editApptId}
                                  onChange={e => setEdit(po.po_id, { appointment_id: e.target.value })}
                                  onKeyDown={onKey}
                                  placeholder="—"
                                  pattern="[A-Za-z0-9\-]*"
                                  className={`${cellCls} font-mono`}
                                />
                              ) : (
                                <span className="text-gray-700 font-mono">{po.appointment_id || '—'}</span>
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
                                  className={cellSelectCls}
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
                        case 'po_id':
                          return <td key={col.key} className="px-3 py-2 font-mono font-semibold text-[#003049] whitespace-nowrap">{po.po_id || '—'}</td>;
                        case 'vendor_po_id':
                          return <td key={col.key} className="px-3 py-2 font-mono text-gray-700 whitespace-nowrap">{po.vendor_po_id || '—'}</td>;
                        case 'total_qty':
                          return <td key={col.key} className="px-3 py-2 font-semibold text-gray-800">{po.total_qty ?? 0}</td>;
                        case 'city':
                          return <td key={col.key} className="px-3 py-2 text-gray-600 whitespace-nowrap">{po.city || '—'}</td>;
                        case 'delivery_code':
                          return (
                            <td key={col.key} className="px-3 py-2">
                              {canEdit ? (
                                <input
                                  type="text"
                                  value={editDeliveryCode}
                                  onChange={e => setEdit(po.po_id, { delivery_code: e.target.value })}
                                  onKeyDown={onKey}
                                  placeholder="—"
                                  className={`${cellCls} font-mono`}
                                />
                              ) : (
                                <span className="text-gray-700 font-mono">{po.delivery_code || '—'}</span>
                              )}
                            </td>
                          );
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
                                  pattern="[A-Za-z0-9\-]*"
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
                                  pattern="[A-Za-z0-9\-]*"
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
                                  title={editNote || undefined}
                                  className={cellNoteCls}
                                />
                              ) : (
                                <span className="text-gray-700 block max-w-[16rem] truncate" title={po.note || undefined}>{po.note || '—'}</span>
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
          leftExtra={<Legend items={UNSAVED_LEGEND} />}
        />
      </div>
    </AppShell>
  );
}
