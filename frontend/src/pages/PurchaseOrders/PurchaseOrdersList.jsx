import { useEffect, useState, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, Pencil, Trash2, FileText, ArrowUp, ArrowDown, ArrowUpDown } from 'lucide-react';
import toast from 'react-hot-toast';
import AppShell from '../../components/layout/AppShell';
import Button from '../../components/ui/Button';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import Badge from '../../components/ui/Badge';
import Pagination, { loadPersistedPageSize, persistPageSize } from '../../components/ui/Pagination';
import { listPOs, deletePO } from '../../api/marketplacePO.api';
import { formatDateTime } from '../../utils/formatters';
import { INDIAN_CITIES } from '../../data/indianCities';

const VENDORS = ['Scootsy', 'Zepto', 'Blinkit'];
const STATUS_COLORS = { Open: 'blue', Closed: 'green' };

const defaultFilters = () => ({
  po_id: '', vendor: '', vendor_po_id: '', city: '',
  po_date_from: '', po_date_to: '',
  po_expiry_date_from: '', po_expiry_date_to: '',
  status: 'Open',
});

const COLUMNS = [
  { key: 'po_id', label: 'PO ID' },
  { key: 'vendor', label: 'Vendor' },
  { key: 'vendor_po_id', label: 'Vendor PO No.' },
  { key: 'city', label: 'City' },
  { key: 'status', label: 'Status' },
  { key: 'onboarded_by_name', label: 'Onboarded By' },
  { key: 'po_date', label: 'PO Date' },
  { key: 'po_expiry_date', label: 'Expiry' },
  { key: 'line_count', label: 'Line Item' },
  { key: 'total_qty', label: 'Total Qty' },
  { key: 'updated_at', label: 'Last Updated' },
];

function expiryTone(po) {
  if (!po.po_expiry_date) return null;
  if (po.status === 'Closed') return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const exp = new Date(po.po_expiry_date); exp.setHours(0, 0, 0, 0);
  const days = Math.round((exp - today) / 86400000);
  if (days < 0) return 'expired';
  if (days <= 2) return 'soon';
  return null;
}

const TONE_ROW = {
  expired: 'bg-red-200/70 hover:bg-red-300/70',
  soon: 'bg-amber-200/70 hover:bg-amber-300/70',
};

export default function PurchaseOrdersList() {
  const navigate = useNavigate();
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState(defaultFilters);
  const [sort, setSort] = useState({ key: 'updated_at', dir: 'desc' });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(() => loadPersistedPageSize('purchaseOrders', 25));
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const buildParams = useCallback((overrides) => {
    const f = overrides?.filters ?? filters;
    const s = overrides?.sort ?? sort;
    const p = overrides?.page ?? page;
    const ps = overrides?.pageSize ?? pageSize;
    const params = { page: p, page_size: ps, sort_by: s.key, sort_dir: s.dir };
    Object.entries(f).forEach(([k, v]) => {
      if (k === 'status' && v === 'All') return;
      if (v) params[k] = v;
    });
    return params;
  }, [filters, sort, page, pageSize]);

  const load = useCallback((overrides) => {
    setLoading(true);
    listPOs(buildParams(overrides))
      .then(res => { setItems(res.rows || []); setTotal(res.total || 0); })
      .catch(() => toast.error('Failed to load purchase orders'))
      .finally(() => setLoading(false));
  }, [buildParams]);

  useEffect(() => { load(); }, [load]);

  const setFilter = (k, v) => setFilters(f => ({ ...f, [k]: v }));
  const onSearchKey = (e) => { if (e.key === 'Enter') applySearch(); };
  const applySearch = () => { setPage(1); load({ page: 1 }); };
  const clearFilters = () => { const f = defaultFilters(); setFilters(f); setPage(1); load({ filters: f, page: 1 }); };

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
    persistPageSize('purchaseOrders', size);
    setPage(1);
    load({ pageSize: size, page: 1 });
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await deletePO(confirmDelete.po_id);
      toast.success(`Deleted ${confirmDelete.po_id}`);
      setConfirmDelete(null);
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Delete failed');
    } finally { setDeleting(false); }
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
          <h1 className="text-2xl font-bold text-[#003049]">Purchase Orders</h1>
          <p className="text-gray-500 text-sm">{total} purchase order{total !== 1 ? 's' : ''}</p>
        </div>
        <Button onClick={() => navigate('/purchase-orders/new')}><Plus size={16} />Add PO</Button>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl p-4 mb-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-9 gap-3">
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
            <label className="block text-xs font-medium text-gray-600 mb-1">Vendor</label>
            <select value={filters.vendor} onChange={e => setFilter('vendor', e.target.value)} className={inputCls}>
              <option value="">All vendors</option>
              {VENDORS.map(v => <option key={v} value={v}>{v}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Vendor PO No.</label>
            <input value={filters.vendor_po_id} onChange={e => setFilter('vendor_po_id', e.target.value)} onKeyDown={onSearchKey} placeholder="Search vendor PO..." className={inputCls} />
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
            <label className="block text-xs font-medium text-gray-600 mb-1">PO Expiry From</label>
            <input type="date" value={filters.po_expiry_date_from} onChange={e => setFilter('po_expiry_date_from', e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">PO Expiry To</label>
            <input type="date" value={filters.po_expiry_date_to} onChange={e => setFilter('po_expiry_date_to', e.target.value)} className={inputCls} />
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
                  <th key={col.key} className="px-4 py-3 text-left font-semibold text-gray-600 whitespace-nowrap bg-gray-50">
                    <button type="button" onClick={() => toggleSort(col.key)} className="inline-flex items-center gap-1 hover:text-[#003049]">
                      {col.label}<SortIcon colKey={col.key} />
                    </button>
                  </th>
                ))}
                <th className="px-4 py-3 text-left font-semibold text-gray-600 whitespace-nowrap bg-gray-50">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                [...Array(4)].map((_, i) => (
                  <tr key={i}><td colSpan={12} className="px-4 py-3"><div className="h-4 bg-gray-100 rounded animate-pulse" /></td></tr>
                ))
              ) : items.map(po => {
                const tone = expiryTone(po);
                const rowCls = tone ? TONE_ROW[tone] : 'hover:bg-gray-50';
                return (
                <tr key={po.po_id} className={`border-b border-gray-100 transition-colors ${rowCls}`}>
                  <td className="px-4 py-3 font-mono font-semibold text-[#003049]">
                    <Link to={`/purchase-orders/${po.po_id}`} className="flex items-center gap-2 hover:underline">
                      <FileText size={14} className="text-gray-400 shrink-0" />{po.po_id}
                    </Link>
                  </td>
                  <td className="px-4 py-3">{po.vendor}</td>
                  <td className="px-4 py-3 font-mono text-gray-700">{po.vendor_po_id}</td>
                  <td className="px-4 py-3 text-gray-600">{po.city || '—'}</td>
                  <td className="px-4 py-3"><Badge color={STATUS_COLORS[po.status] || 'gray'}>{po.status || 'Open'}</Badge></td>
                  <td className="px-4 py-3 text-gray-600">{po.onboarded_by_name || '—'}</td>
                  <td className="px-4 py-3 text-gray-600">{po.po_date || '—'}</td>
                  <td className="px-4 py-3 text-gray-600">{po.po_expiry_date || '—'}</td>
                  <td className="px-4 py-3 font-semibold text-gray-800">{po.line_count}</td>
                  <td className="px-4 py-3 font-semibold text-gray-800">{po.total_qty ?? 0}</td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <div className="text-gray-700">{po.updated_by_name || '—'}</div>
                    <div className="text-xs text-gray-400">{formatDateTime(po.updated_at)}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
                      <Link to={`/purchase-orders/${po.po_id}`} title="View/Edit" className="p-1.5 rounded hover:bg-blue-50 text-blue-500"><Pencil size={14} /></Link>
                      <button onClick={() => setConfirmDelete(po)} title="Delete" className="p-1.5 rounded hover:bg-red-50 text-red-500"><Trash2 size={14} /></button>
                    </div>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
          {!loading && items.length === 0 && (
            <p className="text-center text-gray-400 py-8">No purchase orders match the current filters</p>
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
        title="Delete Purchase Order"
        message={`Delete ${confirmDelete?.po_id} (${confirmDelete?.vendor} ${confirmDelete?.vendor_po_id})? This cannot be undone.`}
        confirmLabel="Delete"
        loading={deleting}
      />
    </AppShell>
  );
}
