import { useEffect, useState } from 'react';
import AppShell from '../../components/layout/AppShell';
import Modal from '../../components/ui/Modal';
import Button from '../../components/ui/Button';
import Badge from '../../components/ui/Badge';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import { getSupplierPOs, createSupplierPO, updatePOStatus } from '../../api/supplierPO.api';
import { getSKUs } from '../../api/skus.api';
import { Plus, ArrowRight } from 'lucide-react';
import toast from 'react-hot-toast';
import { formatDateTime } from '../../utils/formatters';
import { useRBAC } from '../../hooks/useRBAC';

const STATUS_COLOR = { Ordered: 'navy', 'In-Transit': 'orange', Arrived: 'yellow', Received: 'green' };
const STATUS_FLOW = ['Ordered', 'In-Transit', 'Arrived', 'Received'];

const NEXT_STATUS_BY_ROLE = {
  Purchase_Team: { Ordered: 'In-Transit', 'In-Transit': 'Arrived' },
  Stocks_Team:   { Arrived: 'Received' },
  Admin:         { Ordered: 'In-Transit', 'In-Transit': 'Arrived', Arrived: 'Received' },
  Owner:         { Ordered: 'In-Transit', 'In-Transit': 'Arrived', Arrived: 'Received' },
};

export default function SupplierPOs() {
  const { canAccess, role } = useRBAC();
  const canCreate = canAccess('Admin', 'Owner', 'Purchase_Team');

  const [pos, setPOs] = useState([]);
  const [skus, setSKUs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState({ supplier_name: '', sku_id: '', quantity: '' });
  const [saving, setSaving] = useState(false);
  const [confirmStatus, setConfirmStatus] = useState(null);

  const load = () => {
    setLoading(true);
    Promise.all([
      getSupplierPOs().then(r => setPOs(r.data)),
      skus.length === 0 ? getSKUs().then(r => setSKUs(r.data)) : Promise.resolve(),
    ]).catch(() => toast.error('Failed to load data')).finally(() => setLoading(false));
  };
  useEffect(load, []);

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!form.sku_id) return toast.error('Please select a SKU');
    setSaving(true);
    try {
      await createSupplierPO({ ...form, sku_id: parseInt(form.sku_id), quantity: parseInt(form.quantity) });
      toast.success('Supplier PO created');
      setModal(false);
      setForm({ supplier_name: '', sku_id: '', quantity: '' });
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to create PO');
    } finally { setSaving(false); }
  };

  const handleStatusUpdate = async () => {
    setSaving(true);
    try {
      const result = await updatePOStatus(confirmStatus.id, confirmStatus.nextStatus);
      toast.success(`PO #${confirmStatus.id} updated to ${confirmStatus.nextStatus}`);
      if (result.data.inventoryDelta) {
        const delta = result.data.inventoryDelta;
        const msg = Object.entries(delta).map(([k, v]) => `${k}: ${v}`).join(', ');
        toast.success(`Inventory updated: ${msg}`, { duration: 4000 });
      }
      setConfirmStatus(null);
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to update status');
    } finally { setSaving(false); }
  };

  const getNextStatus = (currentStatus) => NEXT_STATUS_BY_ROLE[role]?.[currentStatus];

  const statusImpact = {
    'In-Transit': 'This will add the PO quantity to In-Transit inventory.',
    Received: 'This will move the quantity from In-Transit to On-Hand inventory.',
    Arrived: null,
  };

  return (
    <AppShell>
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#003049]">Supplier POs (Restock)</h1>
          <p className="text-gray-500 text-sm">{pos.length} purchase order{pos.length !== 1 ? 's' : ''}</p>
        </div>
        {canCreate && <Button onClick={() => setModal(true)}><Plus size={16} />New PO</Button>}
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                {['PO #', 'Supplier', 'SKU', 'Qty', 'Status', 'Created By', 'Date', 'Action'].map(h => (
                  <th key={h} className="px-4 py-3 text-left font-semibold text-gray-600 whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                [...Array(4)].map((_, i) => (
                  <tr key={i}><td colSpan={8} className="px-4 py-3"><div className="h-4 bg-gray-100 rounded animate-pulse" /></td></tr>
                ))
              ) : pos.map(po => {
                const next = getNextStatus(po.status);
                return (
                  <tr key={po.id} className="border-b border-gray-100 hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3 font-mono text-xs font-semibold text-[#003049]">#{po.id}</td>
                    <td className="px-4 py-3 font-medium text-gray-900">{po.supplier_name}</td>
                    <td className="px-4 py-3">
                      <p className="font-mono text-xs text-[#003049]">{po.sku_code}</p>
                      <p className="text-xs text-gray-400 truncate max-w-[140px]">{po.sku_name}</p>
                    </td>
                    <td className="px-4 py-3 font-semibold text-gray-800">{parseInt(po.quantity).toLocaleString('en-IN')}</td>
                    <td className="px-4 py-3"><Badge color={STATUS_COLOR[po.status] || 'gray'}>{po.status}</Badge></td>
                    <td className="px-4 py-3 text-gray-600">{po.created_by_name}</td>
                    <td className="px-4 py-3 text-xs text-gray-400 whitespace-nowrap">{formatDateTime(po.created_at)}</td>
                    <td className="px-4 py-3">
                      {next ? (
                        <button
                          onClick={() => setConfirmStatus({ id: po.id, currentStatus: po.status, nextStatus: next, quantity: po.quantity, supplier: po.supplier_name })}
                          className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-[#003049]/10 text-[#003049] hover:bg-[#003049] hover:text-white transition-colors whitespace-nowrap"
                        >
                          → {next}
                        </button>
                      ) : (
                        <span className="text-xs text-gray-300">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!loading && pos.length === 0 && (
            <p className="text-center text-gray-400 py-8">No supplier POs yet</p>
          )}
        </div>
      </div>

      <Modal isOpen={modal} onClose={() => setModal(false)} title="Create Supplier PO" size="sm">
        <form onSubmit={handleCreate} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Supplier Name</label>
            <input required value={form.supplier_name} onChange={e => setForm(f => ({ ...f, supplier_name: e.target.value }))} className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f]" placeholder="e.g. ABC Textiles" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">SKU</label>
            <select required value={form.sku_id} onChange={e => setForm(f => ({ ...f, sku_id: e.target.value }))} className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f]">
              <option value="">Select SKU…</option>
              {skus.map(s => <option key={s.id} value={s.id}>{s.sku_code} — {s.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Quantity</label>
            <input type="number" required min={1} value={form.quantity} onChange={e => setForm(f => ({ ...f, quantity: e.target.value }))} className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f]" placeholder="e.g. 500" />
          </div>
          <div className="flex gap-3 justify-end pt-2">
            <Button variant="ghost" type="button" onClick={() => setModal(false)}>Cancel</Button>
            <Button type="submit" loading={saving}>Create PO</Button>
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        isOpen={!!confirmStatus}
        onClose={() => setConfirmStatus(null)}
        onConfirm={handleStatusUpdate}
        title={`Update PO #${confirmStatus?.id} Status`}
        message={
          confirmStatus
            ? `Change PO from "${confirmStatus.currentStatus}" → "${confirmStatus.nextStatus}" for ${parseInt(confirmStatus.quantity).toLocaleString('en-IN')} units from ${confirmStatus.supplier}?${statusImpact[confirmStatus.nextStatus] ? '\n\n' + statusImpact[confirmStatus.nextStatus] : ''}`
            : ''
        }
        confirmLabel={`Set to ${confirmStatus?.nextStatus}`}
        loading={saving}
      />
    </AppShell>
  );
}
