import { useEffect, useState, useCallback } from 'react';
import * as XLSX from 'xlsx';
import { ArrowUp, ArrowDown, ArrowUpDown, Download, Plus, Save, Trash2, X } from 'lucide-react';
import toast from 'react-hot-toast';
import AppShell from '../../components/layout/AppShell';
import Button from '../../components/ui/Button';
import Modal from '../../components/ui/Modal';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import Legend from '../../components/ui/Legend';
import Pagination, { loadPersistedPageSize, persistPageSize } from '../../components/ui/Pagination';
import PartyNameInput from '../../components/ui/PartyNameInput';
import { HistoryButton } from '../../components/shared/HistoryDrawer';
import { useSessionState } from '../../hooks/useSessionState';
import { useRBAC } from '../../hooks/useRBAC';
import {
  listBalajiBuilty, getBalajiBuiltyTabs, getBalajiBuiltyOptions, updateBalajiBuilty, deleteBalajiBuilty,
} from '../../api/balajiBuilty.api';
import { FIELDS, LABELS, DATE_FIELDS, SUGGESTIONS, MONO_FIELDS, entryFieldsError } from '../../utils/balajiBuilty';
import { formatDateTime } from '../../utils/formatters';
import BalajiBuiltyFormModal from './BalajiBuiltyFormModal';

// Balaji Builty (migration 108): the Builty sheet kept by hand. Builty reads
// its columns from imported marketplace POs; here staff type every one of them
// (free text, with suggestions from values used before), and only PO ID
// (P001, P002 ... assigned on save) and Last Updated are the system's.
//
// TABS ARE THE DATA. There is no vendor master behind this page: it opens on
// All, and each distinct vendor typed into an entry becomes a tab of its own
// (compared ignoring case), counted under the current filters.

const DIRTY_ROW = 'bg-amber-50/60';
const UNSAVED_LEGEND = [{ swatch: DIRTY_ROW, label: 'Unsaved changes' }];
const ALL_TAB = 'All';

const isoLocal = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};
const defaultPoDateFrom = () => {
  const t = new Date();
  return isoLocal(new Date(t.getFullYear(), t.getMonth() - 2, 1));
};
const defaultPoDateTo = () => isoLocal(new Date());

const defaultFilters = () => ({
  po_date_from: defaultPoDateFrom(),
  po_date_to:   defaultPoDateTo(),
  city:         '',
  courier:      '',
});

const COLUMNS = [
  { key: 'po_id', label: 'PO ID' },
  ...FIELDS.map((key) => ({ key, label: LABELS[key] })),
  { key: 'updated_at', label: 'Last Updated' },
];

// Room for each editable cell, so the grid stays readable while typing.
const CELL_WIDTH = {
  po_date: 'w-[9.5rem]', vendor: 'min-w-[9rem]', party_name: 'min-w-[14rem]', vendor_po_id: 'min-w-[9rem]',
  qty: 'w-24', city: 'min-w-[8rem]', expiry_date: 'w-[9.5rem]', dispatch_date: 'w-[9.5rem]',
  courier: 'min-w-[9rem]', tracking_id: 'min-w-[10rem]', bill_no: 'min-w-[8rem]', bill_date: 'w-[9.5rem]',
};

const sameVendor = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

const filterParams = (f) => {
  const params = {};
  Object.entries(f).forEach(([k, val]) => { if (val) params[k] = val; });
  return params;
};

export default function BalajiBuiltyList() {
  const { canEdit } = useRBAC();

  const [tabs, setTabs] = useState({ all: 0, vendors: [] });
  const [vendorTab, setVendorTab] = useSessionState('balajiBuilty.vendorTab', ALL_TAB);
  const [filters, setFilters] = useSessionState('balajiBuilty.filters', defaultFilters);
  const [sort, setSort] = useSessionState('balajiBuilty.sort', { key: 'po_id', dir: 'desc' });
  const [page, setPage] = useSessionState('balajiBuilty.page', 1);
  const [pageSize, setPageSize] = useState(() => loadPersistedPageSize('balajiBuilty', 25));

  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [options, setOptions] = useState({ vendors: [], party_names: [], cities: [], couriers: [] });

  const [edits, setEdits] = useState({});
  const [savingId, setSavingId] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [conflict, setConflict] = useState(null);
  const [adding, setAdding] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const buildParams = useCallback((overrides = {}) => {
    const f = overrides.filters ?? filters;
    const v = overrides.vendor ?? vendorTab;
    const s = overrides.sort ?? sort;
    const p = overrides.page ?? page;
    const ps = overrides.pageSize ?? pageSize;
    const params = { page: p, page_size: ps, sort_by: s.key, sort_dir: s.dir, ...filterParams(f) };
    if (v && v !== ALL_TAB) params.vendor = v;
    return params;
  }, [filters, vendorTab, sort, page, pageSize]);

  const load = useCallback((overrides) => {
    setLoading(true);
    listBalajiBuilty(buildParams(overrides))
      // Fresh rows drop any unsaved edits, which belonged to the old ones.
      .then(res => { setItems(res.rows || []); setTotal(res.total || 0); setEdits({}); })
      .catch(() => toast.error('Failed to load Balaji Builty'))
      .finally(() => setLoading(false));
  }, [buildParams]);

  // The tabs follow the data: a vendor typed into an entry becomes a tab. When
  // the remembered tab's last entry has gone, fall back to All.
  const loadTabs = useCallback((overrideFilters) => {
    getBalajiBuiltyTabs(filterParams(overrideFilters ?? filters))
      .then(res => {
        const next = { all: res.all || 0, vendors: res.vendors || [] };
        setTabs(next);
        if (vendorTab !== ALL_TAB && !next.vendors.some(t => sameVendor(t.vendor, vendorTab))) {
          setVendorTab(ALL_TAB);
          setPage(1);
          load({ vendor: ALL_TAB, page: 1 });
        }
      })
      .catch(() => {});
  }, [filters, vendorTab, setVendorTab, setPage, load]);

  const loadOptions = useCallback(() => {
    getBalajiBuiltyOptions()
      .then(res => setOptions({
        vendors: res.vendors || [], party_names: res.party_names || [],
        cities: res.cities || [], couriers: res.couriers || [],
      }))
      .catch(() => {});
  }, []);

  // Load on mount only. Editing a filter input does NOT fetch -- only an
  // explicit action (Search/Clear/tab/sort/pagination) does.
  useEffect(() => {
    // The first fetch: its synchronous setLoading(true) is a no-op (loading starts true).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    loadTabs();
    loadOptions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // After a save or a delete: the row, the tab counts and the suggestions may all have moved.
  const refreshAll = () => { load(); loadTabs(); loadOptions(); };

  const setFilter = (k, v) => setFilters(f => ({ ...f, [k]: v }));
  const applySearch = () => { setPage(1); load({ page: 1 }); loadTabs(); };
  const clearFilters = () => { const f = defaultFilters(); setFilters(f); setPage(1); load({ filters: f, page: 1 }); loadTabs(f); };

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
    persistPageSize('balajiBuilty', size);
    setPage(1);
    load({ pageSize: size, page: 1 });
  };

  const valueOf = (row, key) => {
    const e = edits[row.po_id];
    const v = e && Object.prototype.hasOwnProperty.call(e, key) ? e[key] : row[key];
    return v == null ? '' : v;
  };
  const isDirty = (row) => !!edits[row.po_id];
  const setEdit = (poId, patch) => setEdits(prev => ({ ...prev, [poId]: { ...(prev[poId] || {}), ...patch } }));
  const cancelEdit = (poId) => setEdits(prev => { const n = { ...prev }; delete n[poId]; return n; });
  const onCellKeyDown = (poId) => (e) => { if (e.key === 'Escape') cancelEdit(poId); };

  const saveRow = async (row) => {
    const e = edits[row.po_id];
    if (!e) return;
    // The rules run on the entry as it will be saved; only the edited fields
    // are sent, so the server leaves the rest alone.
    const err = entryFieldsError({ ...row, ...e });
    if (err) return toast.error(err);

    setSavingId(row.po_id);
    try {
      await updateBalajiBuilty(row.po_id, e);
      toast.success(`Saved ${row.po_id}`);
      cancelEdit(row.po_id);
      setConflict(null);
      refreshAll();
    } catch (ex) {
      const data = ex.response?.data;
      if (ex.response?.status === 409 && data?.error === 'bill_no_duplicate') {
        setConflict({ billNo: String(e.bill_no ?? row.bill_no ?? '').trim(), rows: data.conflicts || [] });
      } else {
        toast.error(data?.message || 'Save failed');
      }
    } finally { setSavingId(null); }
  };

  const doDelete = async () => {
    const row = confirmDelete;
    if (!row) return;
    setDeleting(true);
    try {
      await deleteBalajiBuilty(row.po_id);
      toast.success(`Deleted ${row.po_id}`);
      setConfirmDelete(null);
      refreshAll();
    } catch (ex) {
      toast.error(ex.response?.data?.message || 'Delete failed');
    } finally { setDeleting(false); }
  };

  const downloadXLSX = async () => {
    setExporting(true);
    try {
      const params = buildParams();
      delete params.page;
      params.page_size = 'all';
      const res = await listBalajiBuilty(params);
      const rows = res.rows || [];
      if (rows.length === 0) {
        toast('No records to export');
        return;
      }
      const headers = COLUMNS.map(c => c.label);
      const data = rows.map(r => COLUMNS.map(c => (r[c.key] == null ? '' : r[c.key])));
      const ws = XLSX.utils.aoa_to_sheet([headers, ...data]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Balaji Builty');
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
      const tabSlug = String(vendorTab).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'all';
      XLSX.writeFile(wb, `balaji-builty-${tabSlug}-${stamp}.xlsx`);
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

  const tabList = [
    { key: ALL_TAB, label: 'All', count: tabs.all },
    ...tabs.vendors.map(t => ({ key: t.vendor, label: t.vendor, count: t.count })),
  ];
  const activeTab = tabList.find(t => sameVendor(t.key, vendorTab))?.key ?? ALL_TAB;

  const renderCell = (row, key, onKey) => {
    const width = CELL_WIDTH[key] || '';
    const value = valueOf(row, key);
    if (!canEdit) {
      return (
        <td key={key} className={`px-3 py-2 text-gray-700 whitespace-nowrap ${MONO_FIELDS.includes(key) ? 'font-mono' : ''}`}>
          {row[key] ?? '—'}
        </td>
      );
    }
    if (SUGGESTIONS[key]) {
      return (
        <td key={key} className={`px-3 py-2 ${width}`}>
          <PartyNameInput
            value={value}
            options={options[SUGGESTIONS[key]]}
            onChange={v => setEdit(row.po_id, { [key]: v })}
            onKeyDown={onKey}
            className={cellCls}
          />
        </td>
      );
    }
    return (
      <td key={key} className={`px-3 py-2 ${width}`}>
        <input
          type={DATE_FIELDS.includes(key) ? 'date' : 'text'}
          inputMode={key === 'qty' ? 'numeric' : undefined}
          value={value}
          onChange={e => setEdit(row.po_id, { [key]: e.target.value })}
          onKeyDown={onKey}
          placeholder="—"
          className={`${cellCls} ${MONO_FIELDS.includes(key) ? 'font-mono' : ''} ${key === 'qty' ? 'text-right' : ''}`}
        />
      </td>
    );
  };

  return (
    <AppShell>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <h1 className="text-2xl font-bold text-[#003049]">Balaji Builty</h1>
        <div className="flex gap-2">
          {canEdit && (
            <Button onClick={() => setAdding(true)}>
              <Plus size={16} />Add entry
            </Button>
          )}
          <Button variant="outline" onClick={downloadXLSX} loading={exporting}>
            <Download size={16} />Download XLSX
          </Button>
        </div>
      </div>

      <div className="flex gap-1 mb-4 border-b border-gray-200 overflow-x-auto">
        {tabList.map(t => (
          <button
            key={t.key}
            type="button"
            onClick={() => switchTab(t.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px whitespace-nowrap transition-colors ${activeTab === t.key ? 'border-[#c1121f] text-[#c1121f]' : 'border-transparent text-gray-500 hover:text-[#003049]'}`}
          >
            {t.label} <span className="ml-1 text-gray-400">({t.count ?? 0})</span>
          </button>
        ))}
      </div>

      <div className="bg-white border border-gray-200 rounded-xl p-4 mb-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Order Date From</label>
            <input type="date" value={filters.po_date_from} onChange={e => setFilter('po_date_from', e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Order Date To</label>
            <input type="date" value={filters.po_date_to} onChange={e => setFilter('po_date_to', e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">City</label>
            <select value={filters.city} onChange={e => setFilter('city', e.target.value)} className={inputCls}>
              <option value="">All cities</option>
              {options.cities.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Courier</label>
            <select value={filters.courier} onChange={e => setFilter('courier', e.target.value)} className={inputCls}>
              <option value="">All couriers</option>
              <option value="unassigned">Unassigned</option>
              {options.couriers.map(c => <option key={c} value={c}>{c}</option>)}
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
                <th className="px-3 py-3 w-24 bg-gray-50" />
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
              ) : items.map(row => {
                const dirty = isDirty(row);
                const onKey = onCellKeyDown(row.po_id);
                return (
                  <tr key={row.po_id} className={`border-b border-gray-100 ${dirty ? DIRTY_ROW : 'hover:bg-gray-50'}`}>
                    <td className="px-3 py-2 font-mono text-gray-700 whitespace-nowrap">{row.po_id}</td>
                    {FIELDS.map(key => renderCell(row, key, onKey))}
                    <td className="px-3 py-2 whitespace-nowrap">
                      <div className="text-gray-700">{row.updated_by_name || '—'}</div>
                      <div className="text-xs text-gray-400">{formatDateTime(row.updated_at)}</div>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <div className="flex items-center gap-1">
                        {canEdit && dirty && (
                          <>
                            <button
                              type="button"
                              onClick={() => saveRow(row)}
                              disabled={savingId === row.po_id}
                              title="Save"
                              className="p-1.5 rounded bg-[#c1121f] text-white hover:bg-[#a01019] disabled:opacity-40"
                            >
                              <Save size={14} />
                            </button>
                            <button
                              type="button"
                              onClick={() => cancelEdit(row.po_id)}
                              title="Cancel (Esc)"
                              className="p-1.5 rounded text-gray-500 hover:bg-gray-100"
                            >
                              <X size={14} />
                            </button>
                          </>
                        )}
                        <HistoryButton entityType="balaji_builty" entityId={row.po_id} title={`History — ${row.po_id}`} />
                        {canEdit && (
                          <button
                            type="button"
                            onClick={() => setConfirmDelete(row)}
                            title="Delete"
                            className="p-1.5 rounded text-red-600 hover:bg-red-50"
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!loading && items.length === 0 && (
            <p className="text-center text-gray-400 py-8">
              {tabs.all === 0 && tabs.vendors.length === 0
                ? 'No entries yet — use Add entry to create the first one'
                : 'No entries match the current filters'}
            </p>
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

      {adding && (
        <BalajiBuiltyFormModal
          defaultVendor={activeTab !== ALL_TAB ? activeTab : ''}
          options={options}
          onClose={() => setAdding(false)}
          onSaved={() => { setAdding(false); refreshAll(); }}
        />
      )}

      <ConfirmDialog
        isOpen={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        onConfirm={doDelete}
        loading={deleting}
        title={confirmDelete ? `Delete ${confirmDelete.po_id}?` : 'Delete entry?'}
        message={confirmDelete
          ? `${confirmDelete.po_id} (${confirmDelete.vendor}${confirmDelete.vendor_po_id ? `, PO No. ${confirmDelete.vendor_po_id}` : ''}) will be removed from Balaji Builty. Its number is not reused.`
          : ''}
        confirmLabel="Delete"
      />

      <Modal
        isOpen={!!conflict}
        onClose={() => setConflict(null)}
        title="Bill no already in use"
        size="lg"
      >
        {conflict && (
          <div className="space-y-4 -mx-6 -my-4 px-6 py-4 border-y bg-red-50 border-red-200">
            <p className="text-sm text-red-700 font-medium">
              Bill no <span className="font-mono font-semibold">{conflict.billNo}</span> is already used on another Balaji Builty entry. Bill numbers must be unique. Pick a different value.
            </p>
            <div className="border border-gray-200 rounded-lg overflow-hidden bg-white">
              <table className="w-full text-sm">
                <thead className="bg-red-100 text-red-900">
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold">PO ID</th>
                    <th className="px-3 py-2 text-left font-semibold">Vendor</th>
                    <th className="px-3 py-2 text-left font-semibold">PO No.</th>
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
