import { useEffect, useState, useCallback } from 'react';
import * as XLSX from 'xlsx';
import { ArrowUp, ArrowDown, ArrowUpDown, Download } from 'lucide-react';
import toast from 'react-hot-toast';
import AppShell from '../../components/layout/AppShell';
import Button from '../../components/ui/Button';
import Badge from '../../components/ui/Badge';
import Pagination, { loadPersistedPageSize, persistPageSize } from '../../components/ui/Pagination';
import { useSessionState } from '../../hooks/useSessionState';
import { listLeadTime, getLeadTimeCountsByVendor } from '../../api/leadTime.api';
import { listVendors } from '../../api/vendors.api';
import { isValidDateString } from '../../utils/dateValidation';

// ── date helpers (no date lib in the project; native Date, local time) ──
const isoLocal = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};
const parseISO = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (iso, n) => { const d = parseISO(iso); d.setDate(d.getDate() + n); return isoLocal(d); };

// Which date column the From/To range applies to. Switching the basis changes
// which POs qualify — e.g. on GRN Date the RTV rows drop out, since they carry
// no GRN date. The count of what got hidden is shown under the filter card.
const DATE_BASIS_OPTIONS = [
  { value: 'po_date',       label: 'PO Date' },
  { value: 'dispatch_date', label: 'Dispatch Date' },
  { value: 'grn_date',      label: 'GRN Date' },
];
const basisLabel = (v) => DATE_BASIS_OPTIONS.find(o => o.value === v)?.label || 'PO Date';

// Ready-made ranges. Day 0 of the current month is the last day of the previous
// month, which handles month lengths and leap years without any arithmetic.
const quickRanges = () => {
  const now = new Date();
  const today = isoLocal(now);
  return [
    { key: 'last30',    label: 'Last 30 days', from: addDays(today, -29),                              to: today },
    { key: 'mtd',       label: 'This month',   from: isoLocal(new Date(now.getFullYear(), now.getMonth(), 1)),     to: today },
    { key: 'lastMonth', label: 'Last month',   from: isoLocal(new Date(now.getFullYear(), now.getMonth() - 1, 1)), to: isoLocal(new Date(now.getFullYear(), now.getMonth(), 0)) },
  ];
};

// Opens on the last 30 days of POs — bounded, and the window most people want.
const defaultFilters = () => {
  const [last30] = quickRanges();
  return { date_basis: 'po_date', date_from: last30.from, date_to: last30.to };
};

const ALL_TAB = { key: 'All', label: 'All' };

// Columns rendered as numbers (right-aligned in the table, numeric cells in the
// export so the file pivots).
const NUMERIC_KEYS = new Set(['total_qty', 'grn_qty', 'dispatch_lead', 'grn_lead', 'appointment_lead']);

const buildColumns = (vendorTab) => [
  // Vendor only earns a column on the All tab; on a vendor tab it's redundant.
  ...(vendorTab === ALL_TAB.key ? [{ key: 'vendor', label: 'Vendor' }] : []),
  { key: 'po_date',          label: 'PO Date' },
  { key: 'po_id',            label: 'S. No' },
  { key: 'total_qty',        label: 'Quantity' },
  { key: 'dispatch_date',    label: 'Dispatch Date' },
  { key: 'grn_flag',         label: 'GRN' },
  { key: 'grn_date',         label: 'GRN Date' },
  { key: 'grn_qty',          label: 'QTY' },
  { key: 'appointment_date', label: 'Appointment' },
  { key: 'dispatch_lead',    label: 'Dispatch Lead' },
  { key: 'grn_lead',         label: 'GRN Lead' },
  { key: 'appointment_lead', label: 'Appointment Lead' },
];

const fmtInt  = (v) => (v == null ? '—' : Number(v).toLocaleString('en-IN'));
const fmtLead = (v) => (v == null ? '—' : `${Number(v).toFixed(1)}d`);

// Statistics over the whole filtered set, not just the visible page.
function SummaryTiles({ summary }) {
  const tiles = [
    { label: 'POs',                  value: fmtInt(summary?.po_count) },
    { label: 'PO Qty',               value: fmtInt(summary?.total_qty) },
    { label: 'GRN Qty',              value: fmtInt(summary?.total_grn_qty) },
    { label: 'Avg Dispatch Lead',    value: fmtLead(summary?.avg_dispatch_lead),    sub: `median ${fmtLead(summary?.median_dispatch_lead)}` },
    { label: 'Avg GRN Lead',         value: fmtLead(summary?.avg_grn_lead),         sub: `median ${fmtLead(summary?.median_grn_lead)}` },
    { label: 'Avg Appointment Lead', value: fmtLead(summary?.avg_appointment_lead), sub: `median ${fmtLead(summary?.median_appointment_lead)}` },
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-4">
      {tiles.map(t => (
        <div key={t.label} className="bg-white border border-gray-200 rounded-xl px-4 py-3">
          <div className="text-xs font-medium text-gray-500 truncate">{t.label}</div>
          <div className="text-xl font-bold text-[#003049] mt-0.5">{t.value}</div>
          <div className="text-xs text-gray-400 mt-0.5">{t.sub || ' '}</div>
        </div>
      ))}
    </div>
  );
}

export default function LeadTimeReport() {
  const [vendorTabs, setVendorTabs] = useState([ALL_TAB]);
  const [vendorTab, setVendorTab] = useSessionState('leadTime.vendorTab', ALL_TAB.key);
  const [filters, setFilters] = useSessionState('leadTime.filters', defaultFilters);
  const [sort, setSort] = useSessionState('leadTime.sort', { key: 'created_at', dir: 'desc' });
  const [page, setPage] = useSessionState('leadTime.page', 1);
  const [pageSize, setPageSize] = useState(() => loadPersistedPageSize('leadTime', 25));

  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState(null);
  const [excludedNoDate, setExcludedNoDate] = useState(0);
  const [loading, setLoading] = useState(true);
  const [vendorCounts, setVendorCounts] = useState({});
  const [exporting, setExporting] = useState(false);

  const COLUMNS = buildColumns(vendorTab);

  const buildParams = useCallback((overrides = {}) => {
    const f = overrides.filters ?? filters;
    const v = overrides.vendor ?? vendorTab;
    const s = overrides.sort ?? sort;
    const p = overrides.page ?? page;
    const ps = overrides.pageSize ?? pageSize;
    const params = { page: p, page_size: ps, sort_by: s.key, sort_dir: s.dir };
    if (v && v !== ALL_TAB.key) params.vendor = v;
    if (f.date_basis) params.date_basis = f.date_basis;
    if (f.date_from) params.date_from = f.date_from;
    if (f.date_to) params.date_to = f.date_to;
    return params;
  }, [filters, vendorTab, sort, page, pageSize]);

  const load = useCallback((overrides) => {
    setLoading(true);
    listLeadTime(buildParams(overrides))
      .then(res => {
        setItems(res.rows || []);
        setTotal(res.total || 0);
        setSummary(res.summary || null);
        setExcludedNoDate(res.excluded_no_date || 0);
      })
      .catch(() => toast.error('Failed to load lead time data'))
      .finally(() => setLoading(false));
  }, [buildParams]);

  // Per-tab counts share the date filters (but not the vendor) so each badge
  // matches what that tab will actually show.
  const loadCounts = useCallback((overrideFilters) => {
    const f = overrideFilters ?? filters;
    const params = {};
    if (f.date_basis) params.date_basis = f.date_basis;
    if (f.date_from) params.date_from = f.date_from;
    if (f.date_to) params.date_to = f.date_to;
    getLeadTimeCountsByVendor(params)
      .then(res => setVendorCounts(res.counts || {}))
      .catch(() => {});
  }, [filters]);

  useEffect(() => {
    load({ filters, vendor: vendorTab, page });
    loadCounts(filters);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    listVendors()
      .then(rows => {
        const active = rows.filter(v => v.is_active).map(v => ({ key: v.name, label: v.name }));
        setVendorTabs([ALL_TAB, ...active]);
        // Reconcile a stale stored tab against the loaded vendor list.
        setVendorTab(curr => (curr === ALL_TAB.key || active.some(t => t.key === curr) ? curr : ALL_TAB.key));
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const datesValid = (f) =>
    (!f.date_from || isValidDateString(f.date_from)) && (!f.date_to || isValidDateString(f.date_to));

  const setFilter = (k, v) => setFilters(f => ({ ...f, [k]: v }));

  // Basis switch and the quick-range pills are navigation controls: they apply
  // straight away. Typing raw dates waits for Search, per the app's convention.
  const applyPatch = (patch) => {
    const f = { ...filters, ...patch };
    if (!datesValid(f)) return toast.error('Date has an invalid year');
    setFilters(f);
    setPage(1);
    load({ filters: f, page: 1 });
    loadCounts(f);
  };

  const applySearch = () => {
    if (!datesValid(filters)) return toast.error('Date has an invalid year');
    setPage(1);
    load({ page: 1 });
    loadCounts();
  };

  const clearFilters = () => {
    const f = defaultFilters();
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
    persistPageSize('leadTime', size);
    setPage(1);
    load({ pageSize: size, page: 1 });
  };

  // Exports every record matching the filters, not just the visible page, by
  // re-requesting with page_size=all. Vendor is always included even on a single
  // vendor tab, and numeric columns stay numbers so the file pivots.
  const downloadXLSX = async () => {
    setExporting(true);
    try {
      const params = buildParams({ page: 1 });
      delete params.page;
      params.page_size = 'all';
      const res = await listLeadTime(params);
      const rows = res.rows || [];
      if (rows.length === 0) {
        toast('No records to export');
        return;
      }
      const cols = buildColumns(ALL_TAB.key);
      const headers = cols.map(c => c.label);
      const data = rows.map(r => cols.map(c => {
        const v = r[c.key];
        if (v == null || v === '') return '';
        return NUMERIC_KEYS.has(c.key) ? Number(v) : v;
      }));
      const ws = XLSX.utils.aoa_to_sheet([headers, ...data]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Lead Time');
      const range = `${filters.date_from || 'start'}_${filters.date_to || 'today'}`;
      XLSX.writeFile(wb, `lead-time-${vendorTab.toLowerCase()}-${range}.xlsx`);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Export failed');
    } finally { setExporting(false); }
  };

  const inputCls = 'w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30';

  const SortIcon = ({ colKey }) => {
    if (sort.key !== colKey) return <ArrowUpDown size={12} className="text-gray-300" />;
    return sort.dir === 'asc'
      ? <ArrowUp size={12} className="text-[#c1121f]" />
      : <ArrowDown size={12} className="text-[#c1121f]" />;
  };

  const renderCell = (row, key) => {
    const v = row[key];
    if (key === 'grn_flag') {
      return <Badge color={v === 'Yes' ? 'green' : v === 'RTV' ? 'red' : 'gray'}>{v}</Badge>;
    }
    if (v == null || v === '') return <span className="text-gray-300">—</span>;
    return v;
  };

  const ranges = quickRanges();

  return (
    <AppShell>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#003049]">Lead Time Report</h1>
          <p className="text-gray-500 text-sm">{total} PO{total !== 1 ? 's' : ''} · {vendorTab}</p>
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
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap ${vendorTab === t.key ? 'border-[#c1121f] text-[#c1121f]' : 'border-transparent text-gray-500 hover:text-[#003049]'}`}
          >
            {t.label} <span className="ml-1 text-gray-400">({vendorCounts[t.key] ?? 0})</span>
          </button>
        ))}
      </div>

      <div className="bg-white border border-gray-200 rounded-xl p-4 mb-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Date Basis</label>
            <select
              value={filters.date_basis}
              onChange={e => applyPatch({ date_basis: e.target.value })}
              className={inputCls}
            >
              {DATE_BASIS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">From</label>
            <input type="date" value={filters.date_from} onChange={e => setFilter('date_from', e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">To</label>
            <input type="date" value={filters.date_to} onChange={e => setFilter('date_to', e.target.value)} className={inputCls} />
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 mt-3 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            {ranges.map(r => {
              const active = filters.date_from === r.from && filters.date_to === r.to;
              return (
                <button
                  key={r.key}
                  type="button"
                  onClick={() => applyPatch({ date_from: r.from, date_to: r.to })}
                  className={`px-3 py-1.5 rounded border text-sm font-medium ${active ? 'bg-[#c1121f] text-white border-[#c1121f]' : 'border-gray-200 bg-white text-[#003049] hover:bg-gray-50'}`}
                >
                  {r.label}
                </button>
              );
            })}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={clearFilters}>Clear</Button>
            <Button variant="outline" onClick={applySearch}>Search</Button>
          </div>
        </div>

        {excludedNoDate > 0 && (
          <p className="mt-3 text-xs text-gray-500">
            {excludedNoDate} PO{excludedNoDate !== 1 ? 's' : ''} hidden — no {basisLabel(filters.date_basis)} recorded.
          </p>
        )}
      </div>

      <SummaryTiles summary={summary} />

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-gray-50">
              <tr className="border-b border-gray-200">
                {COLUMNS.map(col => (
                  <th key={col.key} className={`px-3 py-3 font-semibold text-gray-600 whitespace-nowrap bg-gray-50 ${NUMERIC_KEYS.has(col.key) ? 'text-right' : 'text-left'}`}>
                    <button type="button" onClick={() => toggleSort(col.key)} className="inline-flex items-center gap-1 hover:text-[#003049]">
                      {col.label}<SortIcon colKey={col.key} />
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                [...Array(4)].map((_, i) => (
                  <tr key={i}>
                    <td colSpan={COLUMNS.length} className="px-4 py-3">
                      <div className="h-4 bg-gray-100 rounded animate-pulse" />
                    </td>
                  </tr>
                ))
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={COLUMNS.length} className="px-4 py-10 text-center text-gray-500">
                    No POs match these filters.
                  </td>
                </tr>
              ) : items.map(row => (
                <tr key={row.po_id} className="border-b border-gray-100 hover:bg-gray-50/60">
                  {COLUMNS.map(col => (
                    <td key={col.key} className={`px-3 py-2 whitespace-nowrap ${NUMERIC_KEYS.has(col.key) ? 'text-right tabular-nums' : 'text-left'}`}>
                      {renderCell(row, col.key)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
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
