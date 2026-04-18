import { useEffect, useMemo, useState } from 'react';
import AppShell from '../../components/layout/AppShell';
import Modal from '../../components/ui/Modal';
import Button from '../../components/ui/Button';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import { getVendorCodes, createVendorCode, updateVendorCode, deleteVendorCode } from '../../api/productVendorCodes.api';
import { getSKUs } from '../../api/skus.api';
import { Plus, Pencil, Trash2, Search, Upload } from 'lucide-react';
import toast from 'react-hot-toast';
import { useRBAC } from '../../hooks/useRBAC';
import BulkUploadModal from './BulkUploadModal';

const KNOWN_VENDORS = ['Swiggy', 'Zepto', 'Blinkit'];
const EMPTY_FORM = { product_id: '', vendor: '', vendor_item_code: '', product_description: '' };

export default function ProductList() {
  const { canAccess } = useRBAC();
  const canWrite = canAccess('Admin', 'Owner', 'PO_Executive');

  const [rows, setRows] = useState([]);
  const [skus, setSkus] = useState([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [customVendor, setCustomVendor] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [bulkOpen, setBulkOpen] = useState(false);

  const load = () => {
    setLoading(true);
    Promise.all([getVendorCodes(), getSKUs()])
      .then(([r, s]) => { setRows(r.data); setSkus(s.data); })
      .catch(() => toast.error('Failed to load products'))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const vendorOptions = useMemo(() => {
    const extras = Array.from(new Set(rows.map(r => r.vendor).filter(v => v && !KNOWN_VENDORS.includes(v))));
    return [...KNOWN_VENDORS, ...extras.sort()];
  }, [rows]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    if (!q) return rows;
    return rows.filter(r =>
      (r.sku_code || '').toLowerCase().includes(q) ||
      (r.product_description || '').toLowerCase().includes(q) ||
      (r.vendor || '').toLowerCase().includes(q) ||
      (r.vendor_item_code || '').toLowerCase().includes(q)
    );
  }, [rows, search]);

  const openAdd = () => { setForm(EMPTY_FORM); setCustomVendor(false); setModal('add'); };
  const openEdit = (r) => {
    setForm({ product_id: String(r.product_id), vendor: r.vendor, vendor_item_code: r.vendor_item_code, product_description: r.product_description || '' });
    setCustomVendor(!KNOWN_VENDORS.includes(r.vendor));
    setModal({ type: 'edit', id: r.id });
  };

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const payload = {
        product_id: Number(form.product_id),
        vendor: form.vendor.trim(),
        vendor_item_code: form.vendor_item_code.trim(),
        product_description: form.product_description.trim() || null,
      };
      if (modal === 'add') {
        await createVendorCode(payload);
        toast.success('Mapping created');
      } else {
        await updateVendorCode(modal.id, payload);
        toast.success('Mapping updated');
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
      await deleteVendorCode(confirmDelete.id);
      toast.success('Mapping deleted');
      setConfirmDelete(null);
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Delete failed');
    } finally { setSaving(false); }
  };

  return (
    <AppShell>
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#003049]">Products</h1>
          <p className="text-gray-500 text-sm">{filtered.length} of {rows.length} mapping{rows.length !== 1 ? 's' : ''}</p>
        </div>
        <div className="flex gap-3 items-center flex-wrap">
          <div className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search…" className="pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f] w-52" />
          </div>
          {canWrite && <Button variant="ghost" onClick={() => setBulkOpen(true)}><Upload size={16} />Bulk Upload</Button>}
          {canWrite && <Button onClick={openAdd}><Plus size={16} />Add Mapping</Button>}
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                {['Internal Product ID', 'Product Description', 'Vendor', 'Vendor Product ID', canWrite ? 'Actions' : ''].filter(Boolean).map(h => (
                  <th key={h} className="px-4 py-3 text-left font-semibold text-gray-600 whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                [...Array(5)].map((_, i) => (
                  <tr key={i}><td colSpan={5} className="px-4 py-3"><div className="h-4 bg-gray-100 rounded animate-pulse" /></td></tr>
                ))
              ) : filtered.map(r => (
                <tr key={r.id} className="border-b border-gray-100 hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3 font-mono text-xs font-semibold text-[#003049]">{r.sku_code}</td>
                  <td className="px-4 py-3 text-gray-900">{r.product_description || '—'}</td>
                  <td className="px-4 py-3 text-gray-700">{r.vendor}</td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-700">{r.vendor_item_code}</td>
                  {canWrite && (
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        <button onClick={() => openEdit(r)} className="p-1.5 rounded hover:bg-blue-50 text-blue-500"><Pencil size={14} /></button>
                        <button onClick={() => setConfirmDelete({ id: r.id, label: `${r.sku_code} → ${r.vendor}/${r.vendor_item_code}` })} className="p-1.5 rounded hover:bg-red-50 text-red-500"><Trash2 size={14} /></button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && filtered.length === 0 && (
            <p className="text-center text-gray-400 py-8">{search ? 'No mappings match your search' : 'No vendor mappings yet'}</p>
          )}
        </div>
      </div>

      <Modal isOpen={!!modal} onClose={() => setModal(null)} title={modal === 'add' ? 'Add Vendor Mapping' : 'Edit Vendor Mapping'} size="md">
        <form onSubmit={handleSave} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Internal Product <span className="text-red-500">*</span></label>
            <select
              required
              value={form.product_id}
              onChange={e => setForm(f => ({ ...f, product_id: e.target.value }))}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f]"
            >
              <option value="">Select a product…</option>
              {skus.map(s => (
                <option key={s.id} value={s.id}>{s.sku_code} — {s.name}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Vendor <span className="text-red-500">*</span></label>
            {!customVendor ? (
              <select
                required
                value={form.vendor}
                onChange={e => {
                  if (e.target.value === '__other__') { setCustomVendor(true); setForm(f => ({ ...f, vendor: '' })); }
                  else setForm(f => ({ ...f, vendor: e.target.value }));
                }}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f]"
              >
                <option value="">Select a vendor…</option>
                {vendorOptions.map(v => <option key={v} value={v}>{v}</option>)}
                <option value="__other__">Other…</option>
              </select>
            ) : (
              <div className="flex gap-2">
                <input
                  required
                  value={form.vendor}
                  onChange={e => setForm(f => ({ ...f, vendor: e.target.value }))}
                  placeholder="New vendor name"
                  className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f]"
                />
                <button type="button" onClick={() => { setCustomVendor(false); setForm(f => ({ ...f, vendor: '' })); }} className="text-xs text-gray-500 underline">Use list</button>
              </div>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Vendor Product ID <span className="text-red-500">*</span></label>
            <input
              required
              value={form.vendor_item_code}
              onChange={e => setForm(f => ({ ...f, vendor_item_code: e.target.value }))}
              placeholder="e.g. SWG-12345"
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f]"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Product Description</label>
            <textarea
              rows={2}
              value={form.product_description}
              onChange={e => setForm(f => ({ ...f, product_description: e.target.value }))}
              placeholder="Vendor-facing listing title (e.g. Red Cotton Bandana — Pack of 1)"
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f]"
            />
          </div>

          <div className="flex gap-3 justify-end pt-2">
            <Button variant="ghost" type="button" onClick={() => setModal(null)}>Cancel</Button>
            <Button type="submit" loading={saving}>{modal === 'add' ? 'Create Mapping' : 'Save Changes'}</Button>
          </div>
        </form>
      </Modal>

      <BulkUploadModal
        isOpen={bulkOpen}
        onClose={() => setBulkOpen(false)}
        onDone={load}
        existingRows={rows}
      />

      <ConfirmDialog
        isOpen={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        onConfirm={handleDelete}
        title="Delete Mapping"
        message={`Delete mapping "${confirmDelete?.label}"?`}
        confirmLabel="Delete"
        loading={saving}
      />
    </AppShell>
  );
}
