import { useEffect, useState, useCallback } from 'react';
import AppShell from '../../components/layout/AppShell';
import Modal from '../../components/ui/Modal';
import Button from '../../components/ui/Button';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import StatusPill from '../../components/ui/StatusPill';
import AuditDrawer from '../../components/shared/AuditDrawer';
import { getPackaging, createPackaging, updatePackaging, updatePackagingQty, deletePackaging, getPackagingAudit } from '../../api/packaging.api';
import { Plus, Pencil, Trash2, Clock, Package } from 'lucide-react';
import toast from 'react-hot-toast';
import { formatDateTime } from '../../utils/formatters';
import { useRBAC } from '../../hooks/useRBAC';

const UNITS = ['pcs', 'rolls', 'boxes', 'bags', 'sheets', 'kg', 'meters'];
const EMPTY_FORM = { name: '', unit: 'pcs', on_hand_qty: 0, safety_threshold: 0 };

export default function PackagingInventory() {
  const { canAccess } = useRBAC();
  const canWrite = canAccess('Admin', 'Owner');
  const canQty = canAccess('Admin', 'Owner', 'Stocks_Team');

  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [qtyModal, setQtyModal] = useState(null);
  const [qtyForm, setQtyForm] = useState({ qty: '', note: '' });
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [auditDrawer, setAuditDrawer] = useState(null);

  const load = () => {
    setLoading(true);
    getPackaging().then(r => setItems(r.data)).catch(() => toast.error('Failed to load packaging')).finally(() => setLoading(false));
  };
  useEffect(load, []);

  const openAdd = () => { setForm(EMPTY_FORM); setModal('add'); };
  const openEdit = (item) => { setForm({ name: item.name, unit: item.unit, on_hand_qty: item.on_hand_qty, safety_threshold: item.safety_threshold }); setModal({ type: 'edit', id: item.id }); };
  const openQty = (item) => { setQtyForm({ qty: item.on_hand_qty, note: '' }); setQtyModal(item); };

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const payload = { ...form, on_hand_qty: parseInt(form.on_hand_qty) || 0, safety_threshold: parseInt(form.safety_threshold) || 0 };
      if (modal === 'add') {
        await createPackaging(payload);
        toast.success('Packaging material added');
      } else {
        await updatePackaging(modal.id, { name: form.name, unit: form.unit, safety_threshold: parseInt(form.safety_threshold) || 0 });
        toast.success('Packaging material updated');
      }
      setModal(null);
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Save failed');
    } finally { setSaving(false); }
  };

  const handleQtyUpdate = async (e) => {
    e.preventDefault();
    if (qtyForm.qty === '' || parseInt(qtyForm.qty) < 0) return toast.error('Enter a valid quantity');
    setSaving(true);
    try {
      await updatePackagingQty(qtyModal.id, parseInt(qtyForm.qty), qtyForm.note);
      toast.success('Stock updated');
      setQtyModal(null);
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Update failed');
    } finally { setSaving(false); }
  };

  const handleDelete = async () => {
    setSaving(true);
    try {
      await deletePackaging(confirmDelete.id);
      toast.success('Deleted');
      setConfirmDelete(null);
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Delete failed');
    } finally { setSaving(false); }
  };

  const fetchAudit = useCallback((id) => () => getPackagingAudit(id), []);

  return (
    <AppShell>
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#003049]">Packaging Materials</h1>
          <p className="text-gray-500 text-sm">{items.length} material{items.length !== 1 ? 's' : ''}</p>
        </div>
        {canWrite && <Button onClick={openAdd}><Plus size={16} />Add Material</Button>}
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                {['Material', 'Unit', 'On Hand', 'Safety Threshold', 'Status', 'Last Updated', 'Actions'].map(h => (
                  <th key={h} className="px-4 py-3 text-left font-semibold text-gray-600 whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                [...Array(4)].map((_, i) => (
                  <tr key={i}><td colSpan={7} className="px-4 py-3"><div className="h-4 bg-gray-100 rounded animate-pulse" /></td></tr>
                ))
              ) : items.map(item => (
                <tr key={item.id} className={`border-b border-gray-100 transition-colors ${item.is_critical ? 'bg-red-50/40 hover:bg-red-50' : 'hover:bg-gray-50'}`}>
                  <td className="px-4 py-3 font-medium text-gray-900 flex items-center gap-2"><Package size={14} className="text-gray-400 shrink-0" />{item.name}</td>
                  <td className="px-4 py-3 text-gray-500">{item.unit}</td>
                  <td className="px-4 py-3 font-bold text-gray-800">{parseInt(item.on_hand_qty).toLocaleString('en-IN')}</td>
                  <td className="px-4 py-3 text-gray-500">{parseInt(item.safety_threshold).toLocaleString('en-IN')}</td>
                  <td className="px-4 py-3"><StatusPill isCritical={item.is_critical} /></td>
                  <td className="px-4 py-3 text-xs text-gray-400 whitespace-nowrap">{formatDateTime(item.updated_at)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
                      {canQty && <button onClick={() => openQty(item)} title="Update Stock" className="p-1.5 rounded hover:bg-green-50 text-green-600 text-xs font-medium transition-colors">Update Stock</button>}
                      {canWrite && <>
                        <button onClick={() => openEdit(item)} title="Edit" className="p-1.5 rounded hover:bg-blue-50 text-blue-500"><Pencil size={14} /></button>
                        <button onClick={() => setConfirmDelete({ id: item.id, name: item.name })} title="Delete" className="p-1.5 rounded hover:bg-red-50 text-red-500"><Trash2 size={14} /></button>
                      </>}
                      <button onClick={() => setAuditDrawer({ id: item.id, name: item.name })} title="History" className="p-1.5 rounded hover:bg-[#003049]/10 text-[#003049]/60 hover:text-[#003049]"><Clock size={14} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && items.length === 0 && (
            <p className="text-center text-gray-400 py-8">No packaging materials added yet</p>
          )}
        </div>
      </div>

      <Modal isOpen={!!modal} onClose={() => setModal(null)} title={modal === 'add' ? 'Add Packaging Material' : 'Edit Packaging Material'} size="sm">
        <form onSubmit={handleSave} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Material Name</label>
            <input required value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f]" placeholder="e.g. Poly Bags (Small)" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Unit</label>
            <select value={form.unit} onChange={e => setForm(f => ({ ...f, unit: e.target.value }))} className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f]">
              {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
            </select>
          </div>
          {modal === 'add' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Initial On-Hand Qty</label>
              <input type="number" min={0} value={form.on_hand_qty} onChange={e => setForm(f => ({ ...f, on_hand_qty: e.target.value }))} className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f]" />
            </div>
          )}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Safety Threshold</label>
            <input type="number" min={0} value={form.safety_threshold} onChange={e => setForm(f => ({ ...f, safety_threshold: e.target.value }))} className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f]" />
          </div>
          <div className="flex gap-3 justify-end pt-2">
            <Button variant="ghost" type="button" onClick={() => setModal(null)}>Cancel</Button>
            <Button type="submit" loading={saving}>{modal === 'add' ? 'Add Material' : 'Save Changes'}</Button>
          </div>
        </form>
      </Modal>

      <Modal isOpen={!!qtyModal} onClose={() => setQtyModal(null)} title={`Update Stock — ${qtyModal?.name}`} size="sm">
        <form onSubmit={handleQtyUpdate} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">New On-Hand Qty ({qtyModal?.unit})</label>
            <input type="number" min={0} required value={qtyForm.qty} onChange={e => setQtyForm(f => ({ ...f, qty: e.target.value }))} className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f]" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Note (optional)</label>
            <input type="text" value={qtyForm.note} onChange={e => setQtyForm(f => ({ ...f, note: e.target.value }))} className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f]" placeholder="e.g. Received shipment from supplier" />
          </div>
          <div className="flex gap-3 justify-end pt-2">
            <Button variant="ghost" type="button" onClick={() => setQtyModal(null)}>Cancel</Button>
            <Button type="submit" loading={saving}>Update Stock</Button>
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        isOpen={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        onConfirm={handleDelete}
        title="Delete Packaging Material"
        message={`Delete "${confirmDelete?.name}"? This cannot be undone.`}
        confirmLabel="Delete"
        loading={saving}
      />

      <AuditDrawer
        isOpen={!!auditDrawer}
        onClose={() => setAuditDrawer(null)}
        title={`History — ${auditDrawer?.name}`}
        fetchFn={auditDrawer ? fetchAudit(auditDrawer.id) : null}
      />
    </AppShell>
  );
}
