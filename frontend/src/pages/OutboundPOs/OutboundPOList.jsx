import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import * as XLSX from 'xlsx';
import { Plus, Pencil, Trash2, RotateCcw, FileText, Download, ArrowUp, ArrowDown, ArrowUpDown, ChevronDown } from 'lucide-react';
import toast from 'react-hot-toast';
import AppShell from '../../components/layout/AppShell';
import Button from '../../components/ui/Button';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import Badge from '../../components/ui/Badge';
import Pagination, { loadPersistedPageSize, persistPageSize } from '../../components/ui/Pagination';
import { HistoryButton } from '../../components/shared/HistoryDrawer';
import { useSessionState } from '../../hooks/useSessionState';
import { listOutboundPOs, getOutboundPOItemNameCounts, deleteOutboundPO, restoreOutboundPO } from '../../api/outboundPOs.api';
import { listOutboundVendors } from '../../api/outboundVendors.api';
import { listOutboundProducts } from '../../api/outboundProducts.api';
import { FLAG_META, FLAG_FILTER_OPTIONS, flagLabel } from '../../utils/outboundPOFlags';
import { formatDateTime } from '../../utils/formatters';
import { cmpText } from '../../utils/sort';

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
  po_date_from: '', po_date_to: '', flags: ['rate_mismatch', 'missing_incoming_no'],
  incoming_no: '', bill_no: '',
});

// Checkbox dropdown used by both the Status and Flags filters — mirrors
// GRNList's StatusMultiSelect, generalized over its option list.
function MultiSelect({ options, selected, onChange, disabled, allLabel, labelOf = (v) => v }) {
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
  const label = (selected.length === 0 || selected.length === options.length)
    ? allLabel
    : `${selected.length} selected`;
  return (
    <details ref={detRef} className={`relative ${disabled ? 'pointer-events-none opacity-50' : ''}`}>
      <summary className="list-none cursor-pointer flex items-center justify-between w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30">
        <span className="text-gray-700 truncate">{label}</span>
        <ChevronDown size={14} className="text-gray-400 shrink-0" />
      </summary>
      <div className="absolute z-20 mt-1 w-60 bg-white border border-gray-200 rounded-lg shadow-lg p-1 max-h-64 overflow-auto">
        {options.map(s => (
          <label key={s} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-gray-50 cursor-pointer text-sm">
            <input type="checkbox" checked={selected.includes(s)} onChange={() => toggle(s)} />
            <span className="text-gray-700">{labelOf(s)}</span>
          </label>
        ))}
      </div>
    </details>
  );
}

// Multiple flags on one PO are common, so cap the badges and put the full
// breakdown — including which article is at fault — in the hover title.
function FlagCell({ po }) {
  const flags = po.flags || [];
  if (!flags.length) return <span className="text-gray-300">—</span>;
  const offenders = (po.lines || []).filter(l => (l.flags || []).length);
  const detail = offenders.slice(0, 8).map(l =>
    `${l.item_name}${l.variant ? ` · ${l.variant}` : ''} — ${l.flags.map(k => FLAG_META[k]?.label || k).join(', ')}`);
  if (offenders.length > 8) detail.push(`…and ${offenders.length - 8} more line(s)`);
  return (
    <span title={detail.join('\n')} className="inline-flex flex-wrap items-center gap-1 cursor-help">
      {flags.slice(0, 2).map(k => (
        <Badge key={k} color={FLAG_META[k]?.color || 'gray'}>{FLAG_META[k]?.short || k}</Badge>
      ))}
      {flags.length > 2 && <Badge color="gray">+{flags.length - 2}</Badge>}
    </span>
  );
}

// Vendor-level columns rendered once per PO (rowSpan across its line rows),
// split around the Article sub-column group.
const LEFT_COLUMNS = [
  { key: 'id', label: 'Order No' },
  { key: 'vendor_name', label: 'Vendor' },
  { key: 'status', label: 'Status' },
  { key: 'flags', label: 'Flags' },
];
const RIGHT_COLUMNS = [
  { key: 'po_date', label: 'Order Date' },
  { key: 'approved_by_name', label: 'Approved By' },
  { key: 'approval_date', label: 'Approval Date' },
  { key: 'updated_at', label: 'Last Updated' },
];
// One real <td> per line row — no more chip+text blob. Order info first
// (Qty, Rate), then fulfillment tracking (Received, Short), then the
// number derived from those two (Pending) last.
const ARTICLE_COLUMNS = ['Category', 'Item Name', 'Variant', 'Qty', 'UM', 'Rate', 'Received', 'Short', 'Pending'];
const TABLE_COL_COUNT = LEFT_COLUMNS.length + ARTICLE_COLUMNS.length + RIGHT_COLUMNS.length + 2; // + Actions + History

const EXPORT_COLUMNS = [
  { key: 'order_no', header: 'order_no' },
  { key: 'vendor_name', header: 'vendor' },
  { key: 'company_name', header: 'company' },
  { key: 'status', header: 'status' },
  { key: 'flags', header: 'flags' },
  { key: 'approved_by_name', header: 'approved_by' },
  { key: 'po_date', header: 'order_date' },
  { key: 'category', header: 'category' },
  { key: 'item_name', header: 'item_name' },
  { key: 'variant', header: 'variant' },
  { key: 'qty', header: 'qty' },
  { key: 'unit_metric', header: 'um' },
  { key: 'rate', header: 'rate' },
  { key: 'received', header: 'received' },
  { key: 'short', header: 'short' },
  { key: 'pending', header: 'pending' },
  { key: 'updated_by_name', header: 'last_updated_by' },
  { key: 'updated_at', header: 'last_updated_at' },
];

const pending = (l) => Math.max(0, l.qty - l.received - l.short);

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
  const [downloading, setDownloading] = useState(false);
  const [itemNameTab, setItemNameTab] = useSessionState('outboundPOs.itemNameTab', 'All');
  const [taxonomy, setTaxonomy] = useState([]);
  const [itemCounts, setItemCounts] = useState({});

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
          flags: (po.flags || []).map(flagLabel).join(', '),
        };
        if (!po.lines.length) return [{ ...base, category: '', item_name: '', variant: '', qty: '', unit_metric: '', rate: '', received: '', pending: '', short: '' }];
        return po.lines.map(l => ({
          ...base,
          category: l.category, item_name: l.item_name, variant: l.variant || '',
          qty: l.qty, unit_metric: l.unit_metric || '', rate: l.rate,
          received: l.received, pending: pending(l), short: l.short,
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
    listOutboundProducts()
      .then(rows => setTaxonomy((rows || []).filter(r => r.is_active)))
      .catch(() => {});
  }, []);

  // Tabs = All + distinct item names (flat, irrespective of category in the
  // tab bar itself), ordered by (category asc, item_name asc) with an
  // 'Others'-category item pinned last -- mirrors PackagingList.jsx's
  // category-tab pinning, but keyed on the item's category rather than the
  // tab's own label. Sourced from the Outbound Product List taxonomy (one row
  // per (category, item_name), not per variant) rather than the paginated PO
  // list, so tabs reflect the full known set regardless of what page you're on.
  const itemNameTabs = useMemo(() => {
    const sorted = [...taxonomy].sort((a, b) => {
      const aOther = (a.category || '').toLowerCase() === 'others';
      const bOther = (b.category || '').toLowerCase() === 'others';
      if (aOther !== bOther) return aOther ? 1 : -1;
      return cmpText(a.category, b.category) || cmpText(a.item_name, b.item_name);
    });
    // De-dupe by item_name -- outbound_products' UNIQUE is (category, item_name),
    // not item_name alone, so in principle two categories could share a name;
    // the tab bar is "irrespective of category" (flat, one tab per name), so
    // the first sorted occurrence wins. Not observed in current data.
    const seen = new Set();
    const names = sorted.filter(r => (seen.has(r.item_name) ? false : (seen.add(r.item_name), true)));
    return [{ key: 'All', label: 'All' }, ...names.map(r => ({ key: r.item_name, label: r.item_name }))];
  }, [taxonomy]);

  const buildParams = useCallback((overrides) => {
    const f = overrides?.filters ?? filters;
    const s = overrides?.sort ?? sort;
    const p = overrides?.page ?? page;
    const ps = overrides?.pageSize ?? pageSize;
    const itn = overrides?.itemNameTab ?? itemNameTab;
    const params = { page: p, page_size: ps, sort_by: s.key, sort_dir: s.dir };
    if (f.order_no) params.order_no = f.order_no;
    if (f.incoming_no) params.incoming_no = f.incoming_no;
    if (f.bill_no) params.bill_no = f.bill_no;
    if (f.vendor_id) params.vendor_id = f.vendor_id;
    if (f.po_date_from) params.po_date_from = f.po_date_from;
    if (f.po_date_to) params.po_date_to = f.po_date_to;
    if (f.show_deleted) {
      params.status = 'Deleted';
    } else if (Array.isArray(f.status) && f.status.length) {
      params.status = f.status.join(',');
    }
    // Array.isArray guard: a filter object persisted in sessionStorage before
    // this key existed would otherwise blow up on .length.
    if (Array.isArray(f.flags) && f.flags.length) params.flag = f.flags.join(',');
    if (itn && itn !== 'All') params.item_name = itn;
    return params;
  }, [filters, sort, page, pageSize, itemNameTab]);

  const load = useCallback((overrides) => {
    setLoading(true);
    listOutboundPOs(buildParams(overrides))
      .then(res => {
        setItems(res.rows || []);
        setTotal(res.total || 0);
      })
      .catch(() => toast.error('Failed to load outbound POs'))
      .finally(() => setLoading(false));
  }, [buildParams]);

  // Item-name tab badges, scoped by every OTHER active filter (item_name
  // itself excluded server-side) so each tab shows "how many POs would show
  // if I picked this tab, given today's other filters" -- mirrors how
  // Inbound Procurement pairs load()/loadCounts().
  const loadItemCounts = useCallback((overrides) => {
    const { item_name, ...params } = buildParams(overrides); // eslint-disable-line no-unused-vars
    return getOutboundPOItemNameCounts(params)
      .then(res => setItemCounts(res.counts || {}))
      .catch(() => {});
  }, [buildParams]);

  useEffect(() => {
    load({ filters, page });
    loadItemCounts({ filters, page });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setFilter = (k, v) => setFilters(f => ({ ...f, [k]: v }));
  const onSearchKey = (e) => { if (e.key === 'Enter') applySearch(); };
  const applySearch = () => { setPage(1); load({ page: 1 }); loadItemCounts({ page: 1 }); };
  const clearFilters = () => {
    const f = defaultFilters();
    setFilters(f); setPage(1);
    load({ filters: f, page: 1 });
    loadItemCounts({ filters: f, page: 1 });
  };
  const switchItemNameTab = (key) => {
    setItemNameTab(key); setPage(1);
    load({ itemNameTab: key, page: 1 });
  };

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

      {/* Item-name tabs: All + distinct item names, ordered by category then
          name, 'Others'-category items pinned last (see itemNameTabs above). */}
      <div className="flex gap-1 mb-4 border-b border-gray-200 overflow-x-auto">
        {itemNameTabs.map(t => (
          <button
            key={t.key}
            type="button"
            onClick={() => switchItemNameTab(t.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap ${
              itemNameTab === t.key
                ? 'border-[#c1121f] text-[#c1121f]'
                : 'border-transparent text-gray-500 hover:text-[#003049]'
            }`}
          >
            {t.label} <span className="ml-1 text-gray-400">({itemCounts[t.key] ?? 0})</span>
          </button>
        ))}
      </div>

      <div className="bg-white border border-gray-200 rounded-xl p-4 mb-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Status</label>
            <MultiSelect
              options={STATUS_MULTI_OPTIONS}
              selected={filters.status}
              onChange={v => setFilter('status', v)}
              disabled={filters.show_deleted}
              allLabel="All statuses"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Flags</label>
            <MultiSelect
              options={FLAG_FILTER_OPTIONS}
              selected={Array.isArray(filters.flags) ? filters.flags : []}
              onChange={v => setFilter('flags', v)}
              allLabel="All POs"
              labelOf={flagLabel}
            />
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
            <label className="block text-xs font-medium text-gray-600 mb-1">Incoming No</label>
            <input value={filters.incoming_no} onChange={e => setFilter('incoming_no', e.target.value)} onKeyDown={onSearchKey} placeholder="e.g. 1234" className={inputCls} />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Bill No</label>
            <input value={filters.bill_no} onChange={e => setFilter('bill_no', e.target.value)} onKeyDown={onSearchKey} placeholder="Search bill no..." className={inputCls} />
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

      {/* This grid is read-only by design — every field is edited on the PO
          detail screen, which is the only place that validates line totals and
          receipt state. Don't reintroduce inline inputs here. */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
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
                <th rowSpan={2} className="px-4 py-3 text-left font-semibold text-gray-600 whitespace-nowrap bg-gray-50 align-middle border-b border-gray-200">History</th>
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
                        <td rowSpan={lines.length} className="px-4 py-3 align-middle"><FlagCell po={po} /></td>
                      </>
                    )}
                    {l ? (
                      <>
                        <td className="px-3 py-2 text-gray-700 whitespace-nowrap">{l.category}</td>
                        <td className="px-3 py-2 text-gray-700 whitespace-nowrap">{l.item_name}</td>
                        <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{l.variant || '—'}</td>
                        <td className="px-3 py-2 text-gray-700">{l.qty}</td>
                        <td className="px-3 py-2 text-gray-600">{l.unit_metric || '—'}</td>
                        <td className={`px-3 py-2 ${(l.flags || []).includes('rate_mismatch') ? 'text-red-600 font-medium' : 'text-gray-700'}`}>{l.rate}</td>
                        <td className="px-3 py-2 text-gray-700">{l.received}</td>
                        <td className="px-3 py-2 text-gray-700">{l.short}</td>
                        <td className={`px-3 py-2 font-medium ${pending(l) > 0 ? 'text-amber-700' : 'text-gray-800'}`}>{pending(l)}</td>
                      </>
                    ) : (
                      <td colSpan={ARTICLE_COLUMNS.length} className="px-3 py-2 text-xs text-gray-400">—</td>
                    )}
                    {idx === 0 && (
                      <>
                        <td rowSpan={lines.length} className="px-4 py-3 text-gray-600 whitespace-nowrap align-middle">{po.po_date || '—'}</td>
                        <td rowSpan={lines.length} className="px-4 py-3 text-gray-700 whitespace-nowrap align-middle">{po.approved_by_name || 'Not yet approved'}</td>
                        <td rowSpan={lines.length} className="px-4 py-3 text-gray-600 whitespace-nowrap align-middle">{po.approval_date || '—'}</td>
                        <td rowSpan={lines.length} className="px-4 py-3 whitespace-nowrap align-middle">
                          <div className="text-gray-700">{po.updated_by_name || '—'}</div>
                          <div className="text-xs text-gray-400">{formatDateTime(po.updated_at)}</div>
                        </td>
                        <td rowSpan={lines.length} className="px-4 py-3 align-middle">
                          <div className="flex items-center gap-1">
                            <Link to={`/outbound/purchase-orders/${po.id}`} title="View/Edit" className="p-1.5 rounded hover:bg-blue-50 text-blue-500"><Pencil size={14} /></Link>
                            {po.status === 'Deleted' ? (
                              <button onClick={() => setConfirmRestore(po)} title="Restore" className="p-1.5 rounded hover:bg-green-50 text-green-600"><RotateCcw size={14} /></button>
                            ) : (
                              <button onClick={() => setConfirmDelete(po)} title="Delete" className="p-1.5 rounded hover:bg-red-50 text-red-500"><Trash2 size={14} /></button>
                            )}
                          </div>
                        </td>
                        <td rowSpan={lines.length} className="px-4 py-3 align-middle">
                          <HistoryButton entityType="outbound_po" entityId={po.id} title={`PO ${po.order_no} history`} />
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
