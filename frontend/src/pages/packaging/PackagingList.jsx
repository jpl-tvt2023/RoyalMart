import { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import AppShell from '../../components/layout/AppShell';
import Modal from '../../components/ui/Modal';
import Button from '../../components/ui/Button';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import {
  getPackagingRawMaterials, createPackagingRawMaterial, updatePackagingRawMaterial,
  deletePackagingRawMaterial, bulkUpsertPackagingRawMaterials, bulkDeletePackagingRawMaterials,
} from '../../api/packagingRawMaterials.api';
import { Plus, Pencil, Trash2, Search, Upload, Download } from 'lucide-react';
import toast from 'react-hot-toast';
import { useRBAC } from '../../hooks/useRBAC';
import { useSessionState } from '../../hooks/useSessionState';
import { HistoryButton } from '../../components/shared/HistoryDrawer';
import BulkUploadModal from '../products/BulkUploadModal';

// ───────────────────────────── shared helpers ─────────────────────────────

// Export an array-of-objects to an .xlsx whose columns match the bulk-upload
// template (so a downloaded file can be edited and re-uploaded round-trip).
function downloadRows(filename, columns, rows, serialize) {
  const header = columns.map(c => c.header);
  const data = rows.map(r => columns.map(c => {
    const v = serialize ? serialize(r, c.key) : r[c.key];
    return v == null ? '' : v;
  }));
  const ws = XLSX.utils.aoa_to_sheet([header, ...data]);
  ws['!cols'] = header.map(() => ({ wch: 22 }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Export');
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
  XLSX.writeFile(wb, `${filename}-${stamp}.xlsx`);
}

// Set-based row selection for multi-select delete (mirrors ProductList).
function useRowSelection(items, idKey = 'id') {
  const [selected, setSelected] = useState(() => new Set());
  const allSelected = items.length > 0 && items.every(i => selected.has(i[idKey]));
  const toggle = (id) => setSelected(prev => {
    const n = new Set(prev);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });
  const toggleAll = () => setSelected(() => allSelected ? new Set() : new Set(items.map(i => i[idKey])));
  const clear = () => setSelected(new Set());
  return { selected, toggle, toggleAll, allSelected, clear };
}

function BulkDeleteBar({ count, onDelete, onClear }) {
  if (count === 0) return null;
  return (
    <div className="bg-[#003049] text-white rounded-xl px-4 py-3 mb-3 flex items-center gap-3 flex-wrap sticky top-2 z-20 shadow">
      <span className="font-medium whitespace-nowrap">{count} selected</span>
      <Button variant="danger" onClick={onDelete}><Trash2 size={16} />Delete selected</Button>
      <button type="button" onClick={onClear} className="text-white/80 hover:text-white text-sm underline whitespace-nowrap">Clear selection</button>
    </div>
  );
}

// ───────────────────────────── bulk-upload config ─────────────────────────────

const rawMaterialUploadConfig = {
  title: 'Bulk Upload Packaging Products',
  templateFileName: 'packaging-products-template.xlsx',
  headers: ['category', 'item_name', 'variant', 'unit_metric'],
  sampleRow: ['Packaging', 'Corrugated', '5 Ply', 'pcs'],
  requiredKeys: ['category', 'item_name', 'unit_metric'],
  instructions: 'Rows whose Category + Item Name + Variant match an existing product update its unit metric; new combinations are added. Variant is optional — leave it blank for an item that has no variants. The other three columns are required.',
  submit: (rows) => bulkUpsertPackagingRawMaterials(rows),
};

export default function PackagingList() {
  return (
    <AppShell>
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-[#003049]">Packaging Products</h1>
        <p className="text-gray-500 text-sm">
          The master article catalog (Category · Item Name · Variant · Unit Metric) that outbound vendors map to and outbound POs draw from
        </p>
      </div>

      <PackagingCatalogTab />
    </AppShell>
  );
}

// ───────────────────────── Packaging Products catalog ─────────────────────────

const EMPTY_RAW_MATERIAL = { category: '', item_name: '', variant: '', unit_metric: '' };

function PackagingCatalogTab() {
  const { canEdit: canWrite } = useRBAC();

  const [rows, setRows] = useState([]);
  const [search, setSearch] = useSessionState('packaging.catalog.search', '');
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState(EMPTY_RAW_MATERIAL);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);

  const sel = useRowSelection(rows);

  const load = () => {
    setLoading(true);
    getPackagingRawMaterials()
      .then(r => setRows(r.data))
      .catch(() => toast.error('Failed to load packaging products'))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    if (!q) return rows;
    return rows.filter(r =>
      (r.category || '').toLowerCase().includes(q) ||
      (r.item_name || '').toLowerCase().includes(q) ||
      (r.variant || '').toLowerCase().includes(q) ||
      (r.unit_metric || '').toLowerCase().includes(q)
    );
  }, [search, rows]);

  // Categories stay free text (new ones are legitimate), but offering the
  // existing ones as autocomplete keeps "Packaging" from fragmenting into
  // "packaging" / "Packageing" and splitting the catalog.
  const categoryOptions = useMemo(
    () => [...new Set(rows.map(r => r.category).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [rows],
  );

  const openAdd = () => { setForm(EMPTY_RAW_MATERIAL); setModal('add'); };
  const openEdit = (r) => {
    setForm({ category: r.category, item_name: r.item_name, variant: r.variant || '', unit_metric: r.unit_metric });
    setModal({ type: 'edit', id: r.id });
  };

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const payload = {
        category: form.category.trim(),
        item_name: form.item_name.trim(),
        variant: form.variant.trim(),
        unit_metric: form.unit_metric.trim(),
      };
      if (modal === 'add') {
        await createPackagingRawMaterial(payload);
        toast.success('Packaging product created');
      } else {
        await updatePackagingRawMaterial(modal.id, payload);
        toast.success('Packaging product updated');
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
      await deletePackagingRawMaterial(confirmDelete.id);
      toast.success('Packaging product deleted');
      setConfirmDelete(null);
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Delete failed');
    } finally { setSaving(false); }
  };

  const handleBulkDelete = async () => {
    setSaving(true);
    try {
      const r = await bulkDeletePackagingRawMaterials(Array.from(sel.selected));
      toast.success(`Deleted ${r.data.deleted} packaging product${r.data.deleted !== 1 ? 's' : ''}`);
      setConfirmBulk(false);
      sel.clear();
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Delete failed');
    } finally { setSaving(false); }
  };

  const inputCls = 'w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f]';
  const colSpan = 5 + (canWrite ? 2 : 0);

  const downloadXlsx = () => downloadRows('packaging-products', [
    { key: 'category', header: 'category' },
    { key: 'item_name', header: 'item_name' },
    { key: 'variant', header: 'variant' },
    { key: 'unit_metric', header: 'unit_metric' },
    { key: 'vendor_count', header: 'vendors_mapped' },
  ], rows);

  return (
    <>
      <div className="mb-4 flex items-start justify-between flex-wrap gap-3">
        <p className="text-gray-500 text-sm">{filtered.length} of {rows.length} product{rows.length !== 1 ? 's' : ''}</p>
        <div className="flex gap-3 items-center flex-wrap">
          <div className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search packaging products…" className="pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f] w-full sm:w-52" />
          </div>
          <Button variant="ghost" onClick={downloadXlsx} disabled={!rows.length}><Download size={16} />Download XLSX</Button>
          {canWrite && <Button variant="ghost" onClick={() => setBulkOpen(true)}><Upload size={16} />Bulk Upload</Button>}
          {canWrite && <Button onClick={openAdd}><Plus size={16} />Add Packaging Product</Button>}
        </div>
      </div>

      {canWrite && <BulkDeleteBar count={sel.selected.size} onDelete={() => setConfirmBulk(true)} onClear={sel.clear} />}

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                {canWrite && (
                  <th className="px-4 py-3 w-10">
                    <input type="checkbox" checked={sel.allSelected} onChange={sel.toggleAll} aria-label="Select all" />
                  </th>
                )}
                {['Category', 'Item Name', 'Variant', 'Unit Metric', 'Vendors Mapped', canWrite ? 'Actions' : ''].filter(Boolean).map(h => (
                  <th key={h} className="px-4 py-3 text-left font-semibold text-gray-600 whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                [...Array(5)].map((_, i) => (
                  <tr key={i}><td colSpan={colSpan} className="px-4 py-3"><div className="h-4 bg-gray-100 rounded animate-pulse" /></td></tr>
                ))
              ) : filtered.map(r => (
                <tr key={r.id} className="border-b border-gray-100 hover:bg-gray-50 transition-colors">
                  {canWrite && (
                    <td className="px-4 py-3">
                      <input type="checkbox" checked={sel.selected.has(r.id)} onChange={() => sel.toggle(r.id)} />
                    </td>
                  )}
                  <td className="px-4 py-3 text-gray-700">{r.category}</td>
                  <td className="px-4 py-3 font-medium text-gray-900">{r.item_name}</td>
                  <td className="px-4 py-3 text-gray-600">{r.variant || '—'}</td>
                  <td className="px-4 py-3 text-gray-700">{r.unit_metric}</td>
                  {/* Derived count, not a stored field — a native title is used
                      rather than a popover because this table sits in an
                      overflow-auto container that would clip one. */}
                  <td className="px-4 py-3">
                    <span
                      title={(r.vendor_names || []).join('\n') || 'Not mapped to any vendor yet'}
                      className={r.vendor_count ? 'text-gray-700 cursor-help underline decoration-dotted underline-offset-2' : 'text-gray-400'}
                    >
                      {r.vendor_count ?? 0}
                    </span>
                  </td>
                  {canWrite && (
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        <button onClick={() => openEdit(r)} className="p-1.5 rounded hover:bg-blue-50 text-blue-500"><Pencil size={14} /></button>
                        <button onClick={() => setConfirmDelete({ id: r.id, label: `${r.category} / ${r.item_name}${r.variant ? ` / ${r.variant}` : ''}` })} className="p-1.5 rounded hover:bg-red-50 text-red-500"><Trash2 size={14} /></button>
                        <HistoryButton entityType="packaging_raw_material" entityId={r.id} title={`History — ${r.item_name}`} />
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && filtered.length === 0 && (
            <p className="text-center text-gray-400 py-8">{search ? 'No packaging products match your search' : 'No packaging products added yet'}</p>
          )}
        </div>
      </div>

      <Modal isOpen={!!modal} onClose={() => setModal(null)} title={modal === 'add' ? 'Add Packaging Product' : 'Edit Packaging Product'} size="md">
        <form onSubmit={handleSave} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Category <span className="text-red-500">*</span></label>
            <input
              required
              list="packaging-category-options"
              value={form.category}
              onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
              placeholder="e.g. Raw Material, Packaging, Barcode"
              className={inputCls}
            />
            <datalist id="packaging-category-options">
              {categoryOptions.map(c => <option key={c} value={c} />)}
            </datalist>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Item Name <span className="text-red-500">*</span></label>
            <input
              required
              value={form.item_name}
              onChange={e => setForm(f => ({ ...f, item_name: e.target.value }))}
              placeholder="e.g. Corrugated Sheet"
              className={inputCls}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Variant</label>
            <input
              value={form.variant}
              onChange={e => setForm(f => ({ ...f, variant: e.target.value }))}
              placeholder="e.g. 60, 80, 5 Ply — leave blank if the item has no variants"
              className={inputCls}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Unit Metric <span className="text-red-500">*</span></label>
            <input
              required
              value={form.unit_metric}
              onChange={e => setForm(f => ({ ...f, unit_metric: e.target.value }))}
              placeholder="e.g. kg, pcs, meter, roll"
              className={inputCls}
            />
          </div>
          <div className="flex gap-3 justify-end pt-2">
            <Button variant="ghost" type="button" onClick={() => setModal(null)}>Cancel</Button>
            <Button type="submit" loading={saving}>{modal === 'add' ? 'Create' : 'Save Changes'}</Button>
          </div>
        </form>
      </Modal>

      <BulkUploadModal
        isOpen={bulkOpen}
        onClose={() => setBulkOpen(false)}
        onDone={load}
        config={rawMaterialUploadConfig}
      />

      <ConfirmDialog
        isOpen={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        onConfirm={handleDelete}
        title="Delete Packaging Product"
        message={`Delete "${confirmDelete?.label}"?`}
        confirmLabel="Delete"
        loading={saving}
      />

      <ConfirmDialog
        isOpen={confirmBulk}
        onClose={() => setConfirmBulk(false)}
        onConfirm={handleBulkDelete}
        title="Delete Packaging Products"
        message={`Delete ${sel.selected.size} selected product${sel.selected.size !== 1 ? 's' : ''}? This cannot be undone.`}
        confirmLabel="Delete"
        loading={saving}
      />
    </>
  );
}
