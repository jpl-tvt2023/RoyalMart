import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, Pencil, Trash2, FileText } from 'lucide-react';
import toast from 'react-hot-toast';
import AppShell from '../../components/layout/AppShell';
import Button from '../../components/ui/Button';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import { listPOs, deletePO } from '../../api/marketplacePO.api';
import { formatDateTime } from '../../utils/formatters';

const VENDORS = ['Swiggy', 'Zepto', 'Blinkit'];

export default function PurchaseOrdersList() {
  const navigate = useNavigate();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [vendor, setVendor] = useState('');
  const [search, setSearch] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const load = () => {
    setLoading(true);
    const params = {};
    if (vendor) params.vendor = vendor;
    if (search) params.search = search;
    listPOs(params)
      .then(setItems)
      .catch(() => toast.error('Failed to load purchase orders'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); /* eslint-disable-line */ }, [vendor]);

  const onSearchKey = (e) => { if (e.key === 'Enter') load(); };

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

  return (
    <AppShell>
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#003049]">Purchase Orders</h1>
          <p className="text-gray-500 text-sm">{items.length} purchase order{items.length !== 1 ? 's' : ''}</p>
        </div>
        <Button onClick={() => navigate('/purchase-orders/new')}><Plus size={16} />Add PO</Button>
      </div>

      <div className="flex flex-wrap gap-3 mb-4">
        <select value={vendor} onChange={e => setVendor(e.target.value)} className="px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30">
          <option value="">All vendors</option>
          {VENDORS.map(v => <option key={v} value={v}>{v}</option>)}
        </select>
        <input
          placeholder="Search PO ID or vendor PO..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          onKeyDown={onSearchKey}
          className="flex-1 min-w-[200px] px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30"
        />
        <Button variant="outline" onClick={load}>Search</Button>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                {['PO ID', 'Vendor', 'Vendor PO No.', 'City', 'Onboarded By', 'PO Date', 'Expected Delivery', 'Expiry', 'Lines', 'Updated', 'Actions'].map(h => (
                  <th key={h} className="px-4 py-3 text-left font-semibold text-gray-600 whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                [...Array(4)].map((_, i) => (
                  <tr key={i}><td colSpan={11} className="px-4 py-3"><div className="h-4 bg-gray-100 rounded animate-pulse" /></td></tr>
                ))
              ) : items.map(po => (
                <tr key={po.po_id} className="border-b border-gray-100 hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3 font-mono font-semibold text-[#003049]">
                    <Link to={`/purchase-orders/${po.po_id}`} className="flex items-center gap-2 hover:underline">
                      <FileText size={14} className="text-gray-400 shrink-0" />{po.po_id}
                    </Link>
                  </td>
                  <td className="px-4 py-3">{po.vendor}</td>
                  <td className="px-4 py-3 font-mono text-gray-700">{po.vendor_po_id}</td>
                  <td className="px-4 py-3 text-gray-600">{po.city || '—'}</td>
                  <td className="px-4 py-3 text-gray-600">{po.onboarded_by_name || '—'}</td>
                  <td className="px-4 py-3 text-gray-600">{po.po_date || '—'}</td>
                  <td className="px-4 py-3 text-gray-600">{po.expected_delivery_date || '—'}</td>
                  <td className="px-4 py-3 text-gray-600">{po.po_expiry_date || '—'}</td>
                  <td className="px-4 py-3 font-semibold text-gray-800">{po.line_count}</td>
                  <td className="px-4 py-3 text-xs text-gray-400 whitespace-nowrap">{formatDateTime(po.updated_at)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
                      <Link to={`/purchase-orders/${po.po_id}`} title="View/Edit" className="p-1.5 rounded hover:bg-blue-50 text-blue-500"><Pencil size={14} /></Link>
                      <button onClick={() => setConfirmDelete(po)} title="Delete" className="p-1.5 rounded hover:bg-red-50 text-red-500"><Trash2 size={14} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && items.length === 0 && (
            <p className="text-center text-gray-400 py-8">No purchase orders yet</p>
          )}
        </div>
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
