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
import { getPackagingProducts } from '../../api/packagingProducts.api';
import { listOutboundCategories } from '../../api/outboundCategories.api';
import { sortByText } from '../../utils/sort';
import { Plus, Pencil, Trash2, Search, Upload, Download } from 'lucide-react';
import toast from 'react-hot-toast';
import { useRBAC } from '../../hooks/useRBAC';
import { useSessionState } from '../../hooks/useSessionState';
import { HistoryButton } from '../../components/shared/HistoryDrawer';
import BulkUploadModal from '../products/BulkUploadModal';

const TABS = [
  { key: 'raw',      label: 'Raw Material' },
  { key: 'products', label: 'Packaging Products' },
];

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
  title: 'Bulk Upload Packaging Raw Materials',
  templateFileName: 'packaging-raw-materials-template.xlsx',
  headers: ['category', 'item_name', 'unit_metric'],
  sampleRow: ['Corrugated Materials', 'Corrugated Sheet', 'kg'],
  requiredKeys: ['category', 'item_name', 'unit_metric'],
  instructions: 'Rows whose Category + Item Name match an existing row update its unit metric; new combinations are added. All three columns are required.',
  submit: (rows) => bulkUpsertPackagingRawMaterials(rows),
};

export default function PackagingList() {
  const [tab, setTab] = useSessionState('packaging.tab', 'raw');

  return (
    <AppShell>
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-[#003049]">Packaging Products</h1>
        <p className="text-gray-500 text-sm">Packaging raw materials and the packaging article catalog used by outbound vendors</p>
      </div>

      <div className="flex gap-1 mb-4 border-b border-gray-200">
        {TABS.map(t => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${tab === t.key ? 'border-[#c1121f] text-[#c1121f]' : 'border-transparent text-gray-500 hover:text-[#003049]'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'raw'      && <PackagingRawMaterialsTab />}
      {tab === 'products' && <PackagingProductsTab />}
    </AppShell>
  );
}

// ───────────────────────── Packaging Raw Material tab ─────────────────────────

const EMPTY_RAW_MATERIAL = { category: '', item_name: '', unit_metric: '' };

function PackagingRawMaterialsTab() {
  const { canEdit: canWrite } = useRBAC();

  const [rows, setRows] = useState([]);
  const [categories, setCategories] = useState([]);
  const [search, setSearch] = useSessionState('packaging.raw.search', '');
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
      .catch(() => toast.error('Failed to load packaging raw materials'))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  useEffect(() => {
    listOutboundCategories()
      .then(rows => setCategories(sortByText((rows || []).filter(c => c.is_active), c => c.name)))
      .catch(() => {});
  }, []);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    if (!q) return rows;
    return rows.filter(r =>
      (r.category || '').toLowerCase().includes(q) ||
      (r.item_name || '').toLowerCase().includes(q) ||
      (r.unit_metric || '').toLowerCase().includes(q)
    );
  }, [search, rows]);

  const openAdd = () => { setForm(EMPTY_RAW_MATERIAL); setModal('add'); };
  const openEdit = (r) => { setForm({ category: r.category, item_name: r.item_name, unit_metric: r.unit_metric }); setModal({ type: 'edit', id: r.id }); };

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const payload = {
        category: form.category.trim(),
        item_name: form.item_name.trim(),
        unit_metric: form.unit_metric.trim(),
      };
      if (modal === 'add') {
        await createPackagingRawMaterial(payload);
        toast.success('Packaging raw material created');
      } else {
        await updatePackagingRawMaterial(modal.id, payload);
        toast.success('Packaging raw material updated');
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
      toast.success('Packaging raw material deleted');
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
      toast.success(`Deleted ${r.data.deleted} packaging raw material${r.data.deleted !== 1 ? 's' : ''}`);
      setConfirmBulk(false);
      sel.clear();
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Delete failed');
    } finally { setSaving(false); }
  };

  const inputCls = 'w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f]';
  const colSpan = 3 + (canWrite ? 2 : 0);

  const downloadXlsx = () => downloadRows('packaging-raw-materials', [
    { key: 'category', header: 'category' },
    { key: 'item_name', header: 'item_name' },
    { key: 'unit_metric', header: 'unit_metric' },
  ], rows);

  return (
    <>
      <div className="mb-4 flex items-start justify-between flex-wrap gap-3">
        <p className="text-gray-500 text-sm">{filtered.length} of {rows.length} raw material{rows.length !== 1 ? 's' : ''}</p>
        <div className="flex gap-3 items-center flex-wrap">
          <div className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search raw materials…" className="pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f] w-full sm:w-52" />
          </div>
          <Button variant="ghost" onClick={downloadXlsx} disabled={!rows.length}><Download size={16} />Download XLSX</Button>
          {canWrite && <Button variant="ghost" onClick={() => setBulkOpen(true)}><Upload size={16} />Bulk Upload</Button>}
          {canWrite && <Button onClick={openAdd}><Plus size={16} />Add Raw Material</Button>}
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
                {['Category', 'Item Name', 'Unit Metric', canWrite ? 'Actions' : ''].filter(Boolean).map(h => (
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
                  <td className="px-4 py-3 text-gray-700">{r.unit_metric}</td>
                  {canWrite && (
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        <button onClick={() => openEdit(r)} className="p-1.5 rounded hover:bg-blue-50 text-blue-500"><Pencil size={14} /></button>
                        <button onClick={() => setConfirmDelete({ id: r.id, label: `${r.category} / ${r.item_name}` })} className="p-1.5 rounded hover:bg-red-50 text-red-500"><Trash2 size={14} /></button>
                        <HistoryButton entityType="packaging_raw_material" entityId={r.id} title={`History — ${r.item_name}`} />
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && filtered.length === 0 && (
            <p className="text-center text-gray-400 py-8">{search ? 'No raw materials match your search' : 'No packaging raw materials added yet'}</p>
          )}
        </div>
      </div>

      <Modal isOpen={!!modal} onClose={() => setModal(null)} title={modal === 'add' ? 'Add Packaging Raw Material' : 'Edit Packaging Raw Material'} size="md">
        <form onSubmit={handleSave} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Category <span className="text-red-500">*</span></label>
            <select required value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))} className={inputCls}>
              <option value="">Select a category…</option>
              {categories.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
              {form.category && !categories.some(c => c.name === form.category) && (
                <option value={form.category}>{form.category} (inactive)</option>
              )}
            </select>
            {categories.length === 0 && (
              <p className="mt-1 text-xs text-amber-600">No outbound categories exist yet — add them on Configurations → Outbound Categories first.</p>
            )}
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
        title="Delete Packaging Raw Material"
        message={`Delete "${confirmDelete?.label}"?`}
        confirmLabel="Delete"
        loading={saving}
      />

      <ConfirmDialog
        isOpen={confirmBulk}
        onClose={() => setConfirmBulk(false)}
        onConfirm={handleBulkDelete}
        title="Delete Packaging Raw Materials"
        message={`Delete ${sel.selected.size} selected raw material${sel.selected.size !== 1 ? 's' : ''}? This cannot be undone.`}
        confirmLabel="Delete"
        loading={saving}
      />
    </>
  );
}

// ───────────────────────────── Packaging Products tab ─────────────────────────

function PackagingProductsTab() {
  const [rows, setRows] = useState([]);
  const [search, setSearch] = useSessionState('packaging.products.search', '');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    getPackagingProducts()
      .then(r => setRows(r.data))
      .catch(() => toast.error('Failed to load packaging products'))
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    if (!q) return rows;
    return rows.filter(r =>
      (r.category || '').toLowerCase().includes(q) ||
      (r.item_name || '').toLowerCase().includes(q)
    );
  }, [search, rows]);

  const downloadXlsx = () => downloadRows('packaging-products', [
    { key: 'category', header: 'category' },
    { key: 'item_name', header: 'item_name' },
    { key: 'vendor_count', header: 'vendor_count' },
  ], rows);

  return (
    <>
      <div className="mb-4 flex items-start justify-between flex-wrap gap-3">
        <p className="text-gray-500 text-sm">{filtered.length} of {rows.length} article{rows.length !== 1 ? 's' : ''} — derived live from Outbound Vendor mappings</p>
        <div className="flex gap-3 items-center flex-wrap">
          <div className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search packaging products…" className="pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f] w-full sm:w-52" />
          </div>
          <Button variant="ghost" onClick={downloadXlsx} disabled={!rows.length}><Download size={16} />Download XLSX</Button>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                {['Category', 'Item Name', 'Vendors Mapped'].map(h => (
                  <th key={h} className="px-4 py-3 text-left font-semibold text-gray-600 whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                [...Array(5)].map((_, i) => (
                  <tr key={i}><td colSpan={3} className="px-4 py-3"><div className="h-4 bg-gray-100 rounded animate-pulse" /></td></tr>
                ))
              ) : filtered.map((r, idx) => (
                <tr key={`${r.category}|${r.item_name}|${idx}`} className="border-b border-gray-100 hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3 text-gray-700">{r.category}</td>
                  <td className="px-4 py-3 font-medium text-gray-900">{r.item_name}</td>
                  <td className="px-4 py-3 text-gray-700">{r.vendor_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && filtered.length === 0 && (
            <p className="text-center text-gray-400 py-8">{search ? 'No packaging products match your search' : 'No outbound vendor article mappings yet'}</p>
          )}
        </div>
      </div>
    </>
  );
}
