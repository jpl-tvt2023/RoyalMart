import { useEffect, useState, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, Pencil, Trash2, RotateCcw, FileText, ArrowUp, ArrowDown, ArrowUpDown } from 'lucide-react';
import toast from 'react-hot-toast';
import AppShell from '../../components/layout/AppShell';
import Button from '../../components/ui/Button';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import Badge from '../../components/ui/Badge';
import Pagination, { loadPersistedPageSize, persistPageSize } from '../../components/ui/Pagination';
import { useSessionState } from '../../hooks/useSessionState';
import { listOutboundPOs, deleteOutboundPO, restoreOutboundPO } from '../../api/outboundPOs.api';
import { listOutboundVendors } from '../../api/outboundVendors.api';
import { formatDateTime } from '../../utils/formatters';

const STATUS_COLORS = { Open: 'blue', 'Partially Received': 'yellow', Closed: 'green', Deleted: 'gray' };

const defaultFilters = () => ({
  order_no: '', vendor_id: '', status: 'Open',
  po_date_from: '', po_date_to: '',
});

const COLUMNS = [
  { key: 'id', label: 'Order No' },
  { key: 'vendor_name', label: 'Vendor' },
  { key: 'status', label: 'Status' },
  { key: null, label: 'Article' },
  { key: 'po_date', label: 'Order Date' },
  { key: 'updated_at', label: 'Last Updated' },
];

const pending = (l) => Math.max(0, l.qty - l.received - l.short);
const lineTotal = (l) => l.qty * l.rate;
const fmtMoney = (n) => Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });

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

  useEffect(() => {
    listOutboundVendors()
      .then(rows => setVendors(rows.filter(v => v.is_active)))
      .catch(() => {});
  }, []);

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
    listOutboundPOs(buildParams(overrides))
      .then(res => { setItems(res.rows || []); setTotal(res.total || 0); })
      .catch(() => toast.error('Failed to load outbound POs'))
      .finally(() => setLoading(false));
  }, [buildParams]);

  useEffect(() => {
    load({ filters, page });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setFilter = (k, v) => setFilters(f => ({ ...f, [k]: v }));
  const onSearchKey = (e) => { if (e.key === 'Enter') applySearch(); };
  const applySearch = () => { setPage(1); load({ page: 1 }); };
  const clearFilters = () => { const f = defaultFilters(); setFilters(f); setPage(1); load({ filters: f, page: 1 }); };

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
        <Button onClick={() => navigate('/outbound/purchase-orders/new')}><Plus size={16} />Add PO</Button>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl p-4 mb-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Status</label>
            <select value={filters.status} onChange={e => setFilter('status', e.target.value)} className={inputCls}>
              <option value="Open">Open</option>
              <option value="Partially Received">Partially Received</option>
              <option value="Closed">Closed</option>
              <option value="All">All</option>
              <option value="Deleted">Deleted</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Order No</label>
            <input value={filters.order_no} onChange={e => setFilter('order_no', e.target.value)} onKeyDown={onSearchKey} placeholder="e.g. 001" className={inputCls} />
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

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-gray-50">
              <tr className="border-b border-gray-200">
                {COLUMNS.map(col => (
                  <th key={col.label} className="px-4 py-3 text-left font-semibold text-gray-600 whitespace-nowrap bg-gray-50">
                    {col.key ? (
                      <button type="button" onClick={() => toggleSort(col.key)} className="inline-flex items-center gap-1 hover:text-[#003049]">
                        {col.label}<SortIcon colKey={col.key} />
                      </button>
                    ) : col.label}
                  </th>
                ))}
                <th className="px-4 py-3 text-left font-semibold text-gray-600 whitespace-nowrap bg-gray-50">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                [...Array(4)].map((_, i) => (
                  <tr key={i}><td colSpan={7} className="px-4 py-3"><div className="h-4 bg-gray-100 rounded animate-pulse" /></td></tr>
                ))
              ) : items.map(po => (
                <tr key={po.id} className="border-b border-gray-100 hover:bg-gray-50 transition-colors align-top">
                  <td className="px-4 py-3 font-mono font-semibold text-[#003049]">
                    <Link to={`/outbound/purchase-orders/${po.id}`} className="flex items-center gap-2 hover:underline">
                      <FileText size={14} className="text-gray-400 shrink-0" />{po.order_no}
                    </Link>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">{po.vendor_name}</td>
                  <td className="px-4 py-3"><Badge color={STATUS_COLORS[po.status] || 'gray'}>{po.status}</Badge></td>
                  <td className="px-4 py-3">
                    <div className="space-y-1.5">
                      {po.lines.map(l => (
                        <div key={l.id} className="flex items-center gap-2 flex-wrap">
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-700 border border-gray-200 whitespace-nowrap">
                            {l.category} · {l.item_name}{l.variant ? ` · ${l.variant}` : ''}
                          </span>
                          <span className="text-xs text-gray-600 whitespace-nowrap">
                            Qty <b className="text-gray-800">{l.qty}</b>
                            <span className="mx-1 text-gray-300">|</span>Rate <b className="text-gray-800">{fmtMoney(l.rate)}</b>
                            <span className="mx-1 text-gray-300">|</span>Received <b className="text-gray-800">{l.received}</b>
                            <span className="mx-1 text-gray-300">|</span>Pending <b className={pending(l) > 0 ? 'text-amber-700' : 'text-gray-800'}>{pending(l)}</b>
                            <span className="mx-1 text-gray-300">|</span>Short <b className={l.short > 0 ? 'text-red-600' : 'text-gray-800'}>{l.short}</b>
                            <span className="mx-1 text-gray-300">|</span>Total <b className="text-gray-800">{fmtMoney(lineTotal(l))}</b>
                          </span>
                        </div>
                      ))}
                      {po.lines.length === 0 && <span className="text-xs text-gray-400">—</span>}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-gray-600 whitespace-nowrap">{po.po_date || '—'}</td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <div className="text-gray-700">{po.updated_by_name || '—'}</div>
                    <div className="text-xs text-gray-400">{formatDateTime(po.updated_at)}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
                      <Link to={`/outbound/purchase-orders/${po.id}`} title="View/Edit" className="p-1.5 rounded hover:bg-blue-50 text-blue-500"><Pencil size={14} /></Link>
                      {po.status === 'Deleted' ? (
                        <button onClick={() => setConfirmRestore(po)} title="Restore" className="p-1.5 rounded hover:bg-green-50 text-green-600"><RotateCcw size={14} /></button>
                      ) : (
                        <button onClick={() => setConfirmDelete(po)} title="Delete" className="p-1.5 rounded hover:bg-red-50 text-red-500"><Trash2 size={14} /></button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
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
