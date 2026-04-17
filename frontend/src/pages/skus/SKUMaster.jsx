import { useEffect, useState } from 'react';
import AppShell from '../../components/layout/AppShell';
import Modal from '../../components/ui/Modal';
import Button from '../../components/ui/Button';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import { getSKUs, createSKU, updateSKU, deleteSKU } from '../../api/skus.api';
import { Plus, Pencil, Trash2, Search } from 'lucide-react';
import toast from 'react-hot-toast';
import { useRBAC } from '../../hooks/useRBAC';

const EMPTY_FORM = { sku_code: '', name: '', hsn_code: '', fabric_type: '', gsm: '', color: '', safety_threshold: 0 };

export default function SKUMaster() {
  const { canAccess } = useRBAC();
  const canWrite = canAccess('Admin', 'Owner');
  const canDelete = canAccess('Admin');

  const [skus, setSkus] = useState([]);
  const [filtered, setFiltered] = useState([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);

  const load = () => {
    setLoading(true);
    getSKUs().then(r => { setSkus(r.data); setFiltered(r.data); }).catch(() => toast.error('Failed to load SKUs')).finally(() => setLoading(false));
  };
  useEffect(load, []);

  useEffect(() => {
    const q = search.toLowerCase();
    setFiltered(skus.filter(s =>
      s.sku_code.toLowerCase().includes(q) ||
      s.name.toLowerCase().includes(q) ||
      (s.color || '').toLowerCase().includes(q) ||
      (s.fabric_type || '').toLowerCase().includes(q)
    ));
  }, [search, skus]);

  const openAdd = () => { setForm(EMPTY_FORM); setModal('add'); };
  const openEdit = (s) => { setForm({ sku_code: s.sku_code, name: s.name, hsn_code: s.hsn_code || '', fabric_type: s.fabric_type || '', gsm: s.gsm || '', color: s.color || '', safety_threshold: s.safety_threshold }); setModal({ type: 'edit', id: s.id }); };

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const payload = { ...form, gsm: form.gsm ? parseInt(form.gsm) : null, safety_threshold: parseInt(form.safety_threshold) || 0 };
      if (modal === 'add') {
        await createSKU(payload);
        toast.success('SKU created');
      } else {
        await updateSKU(modal.id, payload);
        toast.success('SKU updated');
      }
      setModal(null);
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Save failed');
    } finally { setSaving(false); }
  };

  const handleDelete = async () => {
    setSaving(true);
    try {
      await deleteSKU(confirmDelete.id);
      toast.success('SKU deleted');
      setConfirmDelete(null);
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Delete failed');
    } finally { setSaving(false); }
  };

  const field = (key, label, opts = {}) => (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <input
        type={opts.type || 'text'}
        required={opts.required}
        value={form[key]}
        onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
        placeholder={opts.placeholder}
        className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f]"
      />
    </div>
  );

  return (
    <AppShell>
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#003049]">SKU Master</h1>
          <p className="text-gray-500 text-sm">{filtered.length} of {skus.length} SKU{skus.length !== 1 ? 's' : ''}</p>
        </div>
        <div className="flex gap-3 items-center flex-wrap">
          <div className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search SKUs…" className="pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f] w-52" />
          </div>
          {canWrite && <Button onClick={openAdd}><Plus size={16} />Add SKU</Button>}
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                {['SKU Code', 'Name', 'HSN', 'Fabric', 'GSM', 'Color', 'Safety Threshold', canWrite ? 'Actions' : ''].filter(Boolean).map(h => (
                  <th key={h} className="px-4 py-3 text-left font-semibold text-gray-600 whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                [...Array(5)].map((_, i) => (
                  <tr key={i}><td colSpan={8} className="px-4 py-3"><div className="h-4 bg-gray-100 rounded animate-pulse" /></td></tr>
                ))
              ) : filtered.map(s => (
                <tr key={s.id} className="border-b border-gray-100 hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3 font-mono text-xs font-semibold text-[#003049]">{s.sku_code}</td>
                  <td className="px-4 py-3 font-medium text-gray-900">{s.name}</td>
                  <td className="px-4 py-3 text-gray-500">{s.hsn_code || '—'}</td>
                  <td className="px-4 py-3 text-gray-600">{s.fabric_type || '—'}</td>
                  <td className="px-4 py-3 text-gray-600">{s.gsm || '—'}</td>
                  <td className="px-4 py-3 text-gray-600">{s.color || '—'}</td>
                  <td className="px-4 py-3 text-gray-700 font-medium">{s.safety_threshold.toLocaleString('en-IN')}</td>
                  {canWrite && (
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        <button onClick={() => openEdit(s)} className="p-1.5 rounded hover:bg-blue-50 text-blue-500"><Pencil size={14} /></button>
                        {canDelete && <button onClick={() => setConfirmDelete({ id: s.id, name: s.name })} className="p-1.5 rounded hover:bg-red-50 text-red-500"><Trash2 size={14} /></button>}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && filtered.length === 0 && (
            <p className="text-center text-gray-400 py-8">{search ? 'No SKUs match your search' : 'No SKUs added yet'}</p>
          )}
        </div>
      </div>

      <Modal isOpen={!!modal} onClose={() => setModal(null)} title={modal === 'add' ? 'Add New SKU' : 'Edit SKU'} size="lg">
        <form onSubmit={handleSave} className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {field('sku_code', 'SKU Code', { required: true, placeholder: 'e.g. BND-RED-S1' })}
          {field('name', 'Product Name', { required: true, placeholder: 'e.g. Red Bandana (Single)' })}
          {field('hsn_code', 'HSN Code', { placeholder: 'e.g. 6214' })}
          {field('fabric_type', 'Fabric Type', { placeholder: 'e.g. Cotton' })}
          {field('gsm', 'GSM', { type: 'number', placeholder: 'e.g. 130' })}
          {field('color', 'Color', { placeholder: 'e.g. Red' })}
          <div className="sm:col-span-2">
            <label className="block text-sm font-medium text-gray-700 mb-1">Safety Threshold <span className="text-gray-400 font-normal">(minimum stock level for CRITICAL alert)</span></label>
            <input type="number" min={0} value={form.safety_threshold} onChange={e => setForm(f => ({ ...f, safety_threshold: e.target.value }))} className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f]" />
          </div>
          <div className="sm:col-span-2 flex gap-3 justify-end pt-2">
            <Button variant="ghost" type="button" onClick={() => setModal(null)}>Cancel</Button>
            <Button type="submit" loading={saving}>{modal === 'add' ? 'Create SKU' : 'Save Changes'}</Button>
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        isOpen={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        onConfirm={handleDelete}
        title="Delete SKU"
        message={`Delete "${confirmDelete?.name}"? This will also remove its inventory record.`}
        confirmLabel="Delete SKU"
        loading={saving}
      />
    </AppShell>
  );
}
