import { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import AppShell from '../../components/layout/AppShell';
import Modal from '../../components/ui/Modal';
import Button from '../../components/ui/Button';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import { getVendorCodes, createVendorCode, updateVendorCode, deleteVendorCode, bulkUpsertVendorCodes, bulkDeleteVendorCodes } from '../../api/productVendorCodes.api';
import { getProducts, createProduct, updateProduct, deleteProduct, bulkUpsertProducts, bulkDeleteProducts } from '../../api/products.api';
import { getRawProducts, createRawProduct, updateRawProduct, deleteRawProduct, bulkUpsertRawProducts, bulkDeleteRawProducts } from '../../api/rawProducts.api';
import { getPackagingRawMaterials } from '../../api/packagingRawMaterials.api';
import { listVendors } from '../../api/vendors.api';
import { listCategories } from '../../api/categories.api';
import { sortByText } from '../../utils/sort';
import { Plus, Pencil, Trash2, Search, Upload, Download } from 'lucide-react';
import toast from 'react-hot-toast';
import { useRBAC } from '../../hooks/useRBAC';
import { useSessionState } from '../../hooks/useSessionState';
import { isExcludedPackagingItem } from '../../utils/packagingExclusions';
import { HistoryButton } from '../../components/shared/HistoryDrawer';
import BulkUploadModal from './BulkUploadModal';

const TABS = [
  { key: 'mappings', label: 'Vendor Mappings' },
  { key: 'skus',     label: 'SKUs' },
  { key: 'raw',      label: 'Raw Products' },
];

// ───────────────────────────── shared helpers ─────────────────────────────

// Export an array-of-objects to an .xlsx whose columns match the bulk-upload
// template (so a downloaded file can be edited and re-uploaded round-trip).
// `columns` is [{ key, header }]; `serialize` optionally maps a row→value per key.
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

// Set-based row selection for multi-select delete (mirrors OrderSummaryList).
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

// ───────────────────────────── bulk-upload configs ─────────────────────────────

const mappingsUploadConfig = {
  title: 'Bulk Upload Vendor Mappings',
  templateFileName: 'product-vendor-mappings-template.xlsx',
  headers: ['sku_code', 'vendor', 'vendor_item_code', 'product_description'],
  sampleRow: ['BND-RED-S1', 'Scootsy', 'SCT-12345', 'Red Cotton Bandana (Single Pack)'],
  requiredKeys: ['sku_code', 'vendor', 'vendor_item_code'],
  instructions: 'If a row in your file has the same Vendor and Vendor Product ID as an existing mapping, the existing one will be updated with the new details. New combinations will be added as fresh mappings. The sku_code must match an existing SKU.',
  submit: (rows) => bulkUpsertVendorCodes(rows),
};

const skuUploadConfig = {
  title: 'Bulk Upload SKUs',
  templateFileName: 'skus-template.xlsx',
  headers: ['sku_code', 'description', 'category', 'requirements', 'packaging_requirements', 'barcode_requirements'],
  sampleRow: ['TSHIRT-RED-M', 'Red Tee M', 'Apparel', 'Cotton Fabric Roll:2; Thread Spool:1', 'Corrugated Box|5 Ply:2', 'EAN Barcode:1'],
  requiredKeys: ['sku_code', 'requirements', 'packaging_requirements', 'barcode_requirements'],
  instructions: 'sku_code, requirements, packaging_requirements and barcode_requirements are all required. requirements lists "Raw Product Name:qty" entries separated by semicolons (raw products must already exist on the Raw Products tab). packaging_requirements and barcode_requirements use "Item Name|Variant:qty" entries the same way — omit "|Variant" for items with no variant (e.g. "EAN Barcode:1") — items must already exist under the matching category on the Packaging Products page (Packaging tab / Barcode tab). Rows whose SKU Code matches an existing SKU update it (and replace all three requirement sections); new SKU codes are added.',
  submit: (rows) => bulkUpsertProducts(rows),
};

const rawUploadConfig = {
  title: 'Bulk Upload Raw Products',
  templateFileName: 'raw-products-template.xlsx',
  headers: ['name', 'qty'],
  sampleRow: ['Cotton Fabric Roll', 100],
  requiredKeys: ['name'],
  instructions: 'Rows whose Name matches an existing raw product update its quantity; new names are added. name is required and qty must be a non-negative whole number.',
  submit: (rows) => bulkUpsertRawProducts(rows),
};

export default function ProductList() {
  const [tab, setTab] = useSessionState('products.tab', 'mappings');

  return (
    <AppShell>
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-[#003049]">SKU Products</h1>
        <p className="text-gray-500 text-sm">Internal SKUs, their per-vendor product codes, and raw products</p>
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

      {tab === 'mappings' && <VendorMappingsTab />}
      {tab === 'skus'     && <SKUsTab />}
      {tab === 'raw'      && <RawProductsTab />}
    </AppShell>
  );
}

// ───────────────────────────── Vendor Mappings tab ─────────────────────────────

const EMPTY_MAPPING = { product_id: '', vendor: '', vendor_item_code: '', product_description: '' };

function VendorMappingsTab() {
  const { canEdit: canWrite } = useRBAC();

  const [rows, setRows] = useState([]);
  const [skus, setSkus] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [search, setSearch] = useSessionState('products.mappings.search', '');
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState(EMPTY_MAPPING);
  const [customVendor, setCustomVendor] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);

  const sel = useRowSelection(rows);

  const loadCatalog = () => {
    Promise.all([getProducts(), listVendors().catch(() => [])])
      .then(([s, v]) => {
        setSkus(sortByText(s.data, x => x.sku_code));
        setVendors(Array.isArray(v) ? v : []);
      })
      .catch(() => {});
  };
  const load = () => {
    setLoading(true);
    loadCatalog();
    getVendorCodes()
      .then(r => setRows(r.data))
      .catch(() => toast.error('Failed to load mappings'))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const vendorOptions = useMemo(() => {
    const active = vendors.filter(v => v.is_active).map(v => v.name);
    const extras = Array.from(new Set(rows.map(r => r.vendor).filter(v => v && !active.includes(v))));
    return sortByText([...active, ...extras]);
  }, [rows, vendors]);

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

  const openAdd = () => { loadCatalog(); setForm(EMPTY_MAPPING); setCustomVendor(false); setModal('add'); };
  const openEdit = (r) => {
    loadCatalog();
    setForm({ product_id: String(r.product_id), vendor: r.vendor, vendor_item_code: r.vendor_item_code, product_description: r.product_description || '' });
    setCustomVendor(!vendorOptions.includes(r.vendor));
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

  const handleBulkDelete = async () => {
    setSaving(true);
    try {
      const r = await bulkDeleteVendorCodes(Array.from(sel.selected));
      toast.success(`Deleted ${r.data.deleted} mapping${r.data.deleted !== 1 ? 's' : ''}`);
      setConfirmBulk(false);
      sel.clear();
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Delete failed');
    } finally { setSaving(false); }
  };

  const downloadXlsx = () => downloadRows('product-vendor-mappings', [
    { key: 'sku_code', header: 'sku_code' },
    { key: 'vendor', header: 'vendor' },
    { key: 'vendor_item_code', header: 'vendor_item_code' },
    { key: 'product_description', header: 'product_description' },
  ], rows);

  const colSpan = 4 + (canWrite ? 2 : 0);

  return (
    <>
      <div className="mb-4 flex items-start justify-between flex-wrap gap-3">
        <p className="text-gray-500 text-sm">{rows.length} mapping{rows.length !== 1 ? 's' : ''}</p>
        <div className="flex gap-2 items-center">
          <Button variant="ghost" onClick={downloadXlsx} disabled={!rows.length}><Download size={16} />Download XLSX</Button>
          {canWrite && <Button variant="ghost" onClick={() => setBulkOpen(true)}><Upload size={16} />Bulk Upload</Button>}
          {canWrite && <Button onClick={openAdd}><Plus size={16} />Add Mapping</Button>}
        </div>
      </div>

      <div className="mb-4 flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-0 sm:min-w-[220px] max-w-md">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by SKU, vendor, or description…" className="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f]" />
        </div>
        {search && (
          <span className="text-xs text-gray-500">Showing {filtered.length} of {rows.length}</span>
        )}
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
                {['Internal Product ID', 'Product Description', 'Vendor', 'Vendor Product ID', canWrite ? 'Actions' : ''].filter(Boolean).map(h => (
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
                  <td className="px-4 py-3 font-mono text-xs font-semibold text-[#003049]">{r.sku_code}</td>
                  <td className="px-4 py-3 text-gray-900">{r.product_description || '—'}</td>
                  <td className="px-4 py-3 text-gray-700">{r.vendor}</td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-700">{r.vendor_item_code}</td>
                  {canWrite && (
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        <button onClick={() => openEdit(r)} className="p-1.5 rounded hover:bg-blue-50 text-blue-500"><Pencil size={14} /></button>
                        <button onClick={() => setConfirmDelete({ id: r.id, label: `${r.sku_code} → ${r.vendor}/${r.vendor_item_code}` })} className="p-1.5 rounded hover:bg-red-50 text-red-500"><Trash2 size={14} /></button>
                        <HistoryButton entityType="product_vendor_code" entityId={r.id} title="Mapping history" />
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
                <option key={s.id} value={s.id}>{s.description ? `${s.sku_code} — ${s.description}` : s.sku_code}</option>
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
        config={mappingsUploadConfig}
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

      <ConfirmDialog
        isOpen={confirmBulk}
        onClose={() => setConfirmBulk(false)}
        onConfirm={handleBulkDelete}
        title="Delete Mappings"
        message={`Delete ${sel.selected.size} selected mapping${sel.selected.size !== 1 ? 's' : ''}? This cannot be undone.`}
        confirmLabel="Delete"
        loading={saving}
      />
    </>
  );
}

// ───────────────────────────────── SKUs tab ─────────────────────────────────

const EMPTY_SKU = {
  sku_code: '', description: '', category: '',
  requirements: [{ raw_product_id: '', qty: '' }],
  packaging_requirements: [{ packaging_raw_material_id: '', item_name: '', qty: '' }],
  barcode_requirements: [{ packaging_raw_material_id: '', item_name: '', qty: '' }],
};

const reqSummary = (reqs) => (reqs || []).map(r => `${r.name} ×${r.qty}`).join(', ');
const articleReqSummary = (reqs) => (reqs || []).map(r => `${r.item_name}${r.variant ? ` (${r.variant})` : ''} ×${r.qty}`).join(', ');

// Shared client-side mirror of the server's normaliseRequirementRows: strips
// blank rows, then requires >=1 row, positive-int qtys, and no duplicate ids.
// Reused for all three requirement sections (raw product / packaging / barcode).
function cleanRequirementRows(rows, idField, label) {
  const cleaned = (rows || [])
    .filter(r => r[idField] !== '' && String(r.qty).trim() !== '')
    .map(r => ({ [idField]: Number(r[idField]), qty: parseInt(r.qty, 10) }));
  if (cleaned.length === 0) {
    return { error: `Add at least one ${label} requirement (${label} + qty)` };
  }
  if (cleaned.some(r => !Number.isInteger(r.qty) || r.qty <= 0)) {
    return { error: `Each ${label} requirement qty must be a positive whole number` };
  }
  const ids = cleaned.map(r => r[idField]);
  if (new Set(ids).size !== ids.length) {
    return { error: `A ${label} is listed more than once in requirements` };
  }
  return { ok: cleaned };
}

function SKUsTab() {
  const { canEdit: canWrite } = useRBAC();

  const [skus, setSkus] = useState([]);
  const [categories, setCategories] = useState([]);
  const [rawProducts, setRawProducts] = useState([]);
  const [packagingCatalog, setPackagingCatalog] = useState([]);
  const [search, setSearch] = useSessionState('products.skus.search', '');
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState(EMPTY_SKU);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);

  const sel = useRowSelection(skus);

  const load = () => {
    setLoading(true);
    getProducts()
      .then(r => setSkus(r.data))
      .catch(() => toast.error('Failed to load SKUs'))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const loadCatalog = () => {
    listCategories()
      .then(rows => setCategories(sortByText((rows || []).filter(c => c.is_active), c => c.name)))
      .catch(() => {});
    getRawProducts()
      .then(r => setRawProducts(sortByText(r.data || [], rp => rp.name)))
      .catch(() => {});
    getPackagingRawMaterials()
      .then(r => setPackagingCatalog(r.data || []))
      .catch(() => {});
  };
  useEffect(loadCatalog, []);

  // Packaging Product requirements may only reference the catalog's
  // 'Packaging' category, Barcode requirements only 'Barcode' — the source
  // pages named in the SKU requirements spec (Packaging Items → Packaging tab
  // / Barcode tab). Item Name -> [articles] drives the cascading Item -> Variant
  // selectors, mirroring OutboundVendorsPage's catalog derivation but scoped to
  // one fixed category per section (no Category picker needed here).
  const packagingArticles = useMemo(() => packagingCatalog.filter(r => (r.category || '').toLowerCase() === 'packaging'), [packagingCatalog]);
  const barcodeArticles = useMemo(() => packagingCatalog.filter(r => (r.category || '').toLowerCase() === 'barcode'), [packagingCatalog]);
  const packagingItemNames = useMemo(() => sortByText(Array.from(new Set(packagingArticles.map(a => a.item_name)))), [packagingArticles]);
  // Corrugated is excluded from NEW selections only. packagingArticles above
  // stays unfiltered on purpose, so a SKU that already requires an excluded item
  // still resolves its variants and round-trips on save — filtering it out of
  // the article list too would blank both selects and silently drop the row on
  // the next save (the bug fixed in 6a6a86c, in a different guise).
  const selectablePackagingItemNames = useMemo(
    () => packagingItemNames.filter(n => !isExcludedPackagingItem(n)),
    [packagingItemNames]
  );
  const barcodeItemNames = useMemo(() => sortByText(Array.from(new Set(barcodeArticles.map(a => a.item_name)))), [barcodeArticles]);
  const packagingByItemName = useMemo(() => {
    const map = packagingArticles.reduce((acc, r) => { (acc[r.item_name] ||= []).push(r); return acc; }, {});
    for (const k of Object.keys(map)) map[k] = sortByText(map[k], a => a.variant || '');
    return map;
  }, [packagingArticles]);
  const barcodeByItemName = useMemo(() => {
    const map = barcodeArticles.reduce((acc, r) => { (acc[r.item_name] ||= []).push(r); return acc; }, {});
    for (const k of Object.keys(map)) map[k] = sortByText(map[k], a => a.variant || '');
    return map;
  }, [barcodeArticles]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    if (!q) return skus;
    return skus.filter(s =>
      (s.sku_code || '').toLowerCase().includes(q) ||
      (s.description || '').toLowerCase().includes(q) ||
      (s.category || '').toLowerCase().includes(q)
    );
  }, [search, skus]);

  const openAdd = () => { loadCatalog(); setForm(EMPTY_SKU); setModal('add'); };
  const openEdit = (s) => {
    loadCatalog();
    setForm({
      sku_code: s.sku_code,
      description: s.description || '',
      category: s.category || '',
      requirements: (s.requirements && s.requirements.length)
        ? s.requirements.map(r => ({ raw_product_id: String(r.raw_product_id), qty: String(r.qty) }))
        : [{ raw_product_id: '', qty: '' }],
      packaging_requirements: (s.packaging_requirements && s.packaging_requirements.length)
        ? s.packaging_requirements.map(r => ({ packaging_raw_material_id: String(r.packaging_raw_material_id), item_name: r.item_name, qty: String(r.qty) }))
        : [{ packaging_raw_material_id: '', item_name: '', qty: '' }],
      barcode_requirements: (s.barcode_requirements && s.barcode_requirements.length)
        ? s.barcode_requirements.map(r => ({ packaging_raw_material_id: String(r.packaging_raw_material_id), item_name: r.item_name, qty: String(r.qty) }))
        : [{ packaging_raw_material_id: '', item_name: '', qty: '' }],
    });
    setModal({ type: 'edit', id: s.id });
  };

  // Requirement row editing, generalised over the three sections (raw
  // product / packaging / barcode) — each just picks its field name and the
  // empty-row template to append.
  const makeRowHelpers = (field, emptyRow) => ({
    set: (idx, patch) => setForm(f => ({ ...f, [field]: f[field].map((r, i) => i === idx ? { ...r, ...patch } : r) })),
    add: () => setForm(f => ({ ...f, [field]: [...f[field], emptyRow] })),
    remove: (idx) => setForm(f => ({ ...f, [field]: f[field].filter((_, i) => i !== idx) })),
  });
  const rawReq = makeRowHelpers('requirements', { raw_product_id: '', qty: '' });
  const pkgReq = makeRowHelpers('packaging_requirements', { packaging_raw_material_id: '', item_name: '', qty: '' });
  const bcReq = makeRowHelpers('barcode_requirements', { packaging_raw_material_id: '', item_name: '', qty: '' });

  const handleSave = async (e) => {
    e.preventDefault();
    const raw = cleanRequirementRows(form.requirements, 'raw_product_id', 'raw product');
    if (raw.error) { toast.error(raw.error); return; }
    const pkg = cleanRequirementRows(form.packaging_requirements, 'packaging_raw_material_id', 'packaging product');
    if (pkg.error) { toast.error(pkg.error); return; }
    const bc = cleanRequirementRows(form.barcode_requirements, 'packaging_raw_material_id', 'barcode');
    if (bc.error) { toast.error(bc.error); return; }
    setSaving(true);
    try {
      const payload = {
        sku_code: form.sku_code.trim(),
        description: form.description.trim() || null,
        category: form.category || null,
        requirements: raw.ok,
        packaging_requirements: pkg.ok,
        barcode_requirements: bc.ok,
      };
      if (modal === 'add') {
        await createProduct(payload);
        toast.success('SKU created');
      } else {
        await updateProduct(modal.id, payload);
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
      await deleteProduct(confirmDelete.id);
      toast.success('SKU deleted');
      setConfirmDelete(null);
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Delete failed');
    } finally { setSaving(false); }
  };

  const handleBulkDelete = async () => {
    setSaving(true);
    try {
      const r = await bulkDeleteProducts(Array.from(sel.selected));
      toast.success(`Deleted ${r.data.deleted} SKU${r.data.deleted !== 1 ? 's' : ''}`);
      setConfirmBulk(false);
      sel.clear();
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Delete failed');
    } finally { setSaving(false); }
  };

  const fieldBase = 'px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f]';
  const inputCls = `w-full ${fieldBase}`;
  const colSpan = 6 + (canWrite ? 2 : 0);

  const downloadXlsx = () => downloadRows('skus', [
    { key: 'sku_code', header: 'sku_code' },
    { key: 'description', header: 'description' },
    { key: 'category', header: 'category' },
    { key: 'requirements', header: 'requirements' },
    { key: 'packaging_requirements', header: 'packaging_requirements' },
    { key: 'barcode_requirements', header: 'barcode_requirements' },
  ], skus, (r, key) => {
    if (key === 'requirements') return (r.requirements || []).map(req => `${req.name}:${req.qty}`).join('; ');
    if (key === 'packaging_requirements' || key === 'barcode_requirements') {
      return (r[key] || []).map(req => `${req.item_name}${req.variant ? `|${req.variant}` : ''}:${req.qty}`).join('; ');
    }
    return r[key];
  });

  return (
    <>
      <div className="mb-4 flex items-start justify-between flex-wrap gap-3">
        <p className="text-gray-500 text-sm">{filtered.length} of {skus.length} SKU{skus.length !== 1 ? 's' : ''}</p>
        <div className="flex gap-3 items-center flex-wrap">
          <div className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search SKUs…" className="pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f] w-full sm:w-52" />
          </div>
          <Button variant="ghost" onClick={downloadXlsx} disabled={!skus.length}><Download size={16} />Download XLSX</Button>
          {canWrite && <Button variant="ghost" onClick={() => setBulkOpen(true)}><Upload size={16} />Bulk Upload</Button>}
          {canWrite && <Button onClick={openAdd}><Plus size={16} />Add SKU</Button>}
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
                {['SKU Code', 'Description', 'Category', 'Raw Product', 'Packaging', 'Barcode', canWrite ? 'Actions' : ''].filter(Boolean).map(h => (
                  <th key={h} className="px-4 py-3 text-left font-semibold text-gray-600 whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                [...Array(5)].map((_, i) => (
                  <tr key={i}><td colSpan={colSpan} className="px-4 py-3"><div className="h-4 bg-gray-100 rounded animate-pulse" /></td></tr>
                ))
              ) : filtered.map(s => (
                <tr key={s.id} className="border-b border-gray-100 hover:bg-gray-50 transition-colors">
                  {canWrite && (
                    <td className="px-4 py-3">
                      <input type="checkbox" checked={sel.selected.has(s.id)} onChange={() => sel.toggle(s.id)} />
                    </td>
                  )}
                  <td className="px-4 py-3 font-mono text-xs font-semibold text-[#003049]">{s.sku_code}</td>
                  <td className="px-4 py-3 text-gray-900">{s.description || '—'}</td>
                  <td className="px-4 py-3 text-gray-600">{s.category || '—'}</td>
                  <td className="px-4 py-3 text-gray-700">{reqSummary(s.requirements) || '—'}</td>
                  <td className="px-4 py-3 text-gray-700">{articleReqSummary(s.packaging_requirements) || '—'}</td>
                  <td className="px-4 py-3 text-gray-700">{articleReqSummary(s.barcode_requirements) || '—'}</td>
                  {canWrite && (
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        <button onClick={() => openEdit(s)} className="p-1.5 rounded hover:bg-blue-50 text-blue-500"><Pencil size={14} /></button>
                        <button onClick={() => setConfirmDelete({ id: s.id, label: s.description || s.sku_code })} className="p-1.5 rounded hover:bg-red-50 text-red-500"><Trash2 size={14} /></button>
                        <HistoryButton entityType="product" entityId={s.id} title={`History — ${s.sku_code}`} />
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
        <form onSubmit={handleSave} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">SKU Code <span className="text-red-500">*</span></label>
              <input required value={form.sku_code} onChange={e => setForm(f => ({ ...f, sku_code: e.target.value }))} placeholder="e.g. TSHIRT-RED-M" className={inputCls} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Category</label>
              <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))} className={inputCls}>
                <option value="">— None —</option>
                {categories.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
                {form.category && !categories.some(c => c.name === form.category) && (
                  <option value={form.category}>{form.category} (inactive)</option>
                )}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
              <input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Optional" className={inputCls} />
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-sm font-medium text-gray-700">Raw Product <span className="text-red-500">*</span></label>
              <button type="button" onClick={rawReq.add} className="inline-flex items-center gap-1 text-sm text-[#c1121f] hover:underline"><Plus size={14} />Add requirement</button>
            </div>
            <p className="text-xs text-gray-500 mb-2">The raw products and quantities consumed to make one unit of this SKU.</p>
            {rawProducts.length === 0 && (
              <p className="text-xs text-amber-600 mb-2">No raw products exist yet — add them on the Raw Products tab first.</p>
            )}
            <div className="space-y-2">
              {form.requirements.map((r, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <select
                    value={r.raw_product_id}
                    onChange={e => rawReq.set(idx, { raw_product_id: e.target.value })}
                    className={`${fieldBase} flex-1 min-w-0`}
                  >
                    <option value="">— Select raw product —</option>
                    {rawProducts.map(rp => <option key={rp.id} value={rp.id}>{rp.name}</option>)}
                  </select>
                  <input
                    type="number"
                    min={1}
                    value={r.qty}
                    onChange={e => rawReq.set(idx, { qty: e.target.value })}
                    placeholder="Qty"
                    className={`${fieldBase} w-24 shrink-0`}
                  />
                  <button
                    type="button"
                    onClick={() => rawReq.remove(idx)}
                    disabled={form.requirements.length === 1}
                    title="Remove"
                    className="p-1.5 rounded text-red-500 hover:bg-red-50 disabled:opacity-30"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-sm font-medium text-gray-700">Packaging Product <span className="text-red-500">*</span></label>
              <button type="button" onClick={pkgReq.add} className="inline-flex items-center gap-1 text-sm text-[#c1121f] hover:underline"><Plus size={14} />Add requirement</button>
            </div>
            <p className="text-xs text-gray-500 mb-2">The packaging products and quantities consumed to make one unit of this SKU.</p>
            {selectablePackagingItemNames.length === 0 && (
              <p className="text-xs text-amber-600 mb-2">No packaging products exist yet — add them under Configurations → Packaging Items (Packaging tab) first.</p>
            )}
            <div className="space-y-2">
              {form.packaging_requirements.map((r, idx) => {
                const variantOptions = packagingByItemName[r.item_name] || [];
                const excludedButSaved = r.item_name && isExcludedPackagingItem(r.item_name);
                return (
                  <div key={idx} className="flex items-center gap-2">
                    <select
                      value={r.item_name}
                      onChange={e => pkgReq.set(idx, { item_name: e.target.value, packaging_raw_material_id: '' })}
                      className={`${fieldBase} flex-1 min-w-0`}
                    >
                      <option value="">— Select item —</option>
                      {/* Already saved against an item that is no longer offered:
                          keep it selectable so editing the SKU does not drop it. */}
                      {excludedButSaved && <option value={r.item_name}>{r.item_name} (no longer offered)</option>}
                      {selectablePackagingItemNames.map(n => <option key={n} value={n}>{n}</option>)}
                    </select>
                    <select
                      value={r.packaging_raw_material_id}
                      onChange={e => pkgReq.set(idx, { packaging_raw_material_id: e.target.value })}
                      disabled={!r.item_name}
                      className={`${fieldBase} flex-1 min-w-0`}
                    >
                      <option value="">— Select variant —</option>
                      {variantOptions.map(a => <option key={a.id} value={a.id}>{a.variant || '— none —'}</option>)}
                    </select>
                    <input
                      type="number"
                      min={1}
                      value={r.qty}
                      onChange={e => pkgReq.set(idx, { qty: e.target.value })}
                      placeholder="Qty"
                      className={`${fieldBase} w-24 shrink-0`}
                    />
                    <button
                      type="button"
                      onClick={() => pkgReq.remove(idx)}
                      disabled={form.packaging_requirements.length === 1}
                      title="Remove"
                      className="p-1.5 rounded text-red-500 hover:bg-red-50 disabled:opacity-30"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-sm font-medium text-gray-700">Barcode <span className="text-red-500">*</span></label>
              <button type="button" onClick={bcReq.add} className="inline-flex items-center gap-1 text-sm text-[#c1121f] hover:underline"><Plus size={14} />Add requirement</button>
            </div>
            <p className="text-xs text-gray-500 mb-2">The barcode(s) and quantities consumed to make one unit of this SKU.</p>
            {barcodeItemNames.length === 0 && (
              <p className="text-xs text-amber-600 mb-2">No barcodes exist yet — add them under Configurations → Packaging Items (Barcode tab) first.</p>
            )}
            <div className="space-y-2">
              {form.barcode_requirements.map((r, idx) => {
                const variantOptions = barcodeByItemName[r.item_name] || [];
                return (
                  <div key={idx} className="flex items-center gap-2">
                    <select
                      value={r.item_name}
                      onChange={e => bcReq.set(idx, { item_name: e.target.value, packaging_raw_material_id: '' })}
                      className={`${fieldBase} flex-1 min-w-0`}
                    >
                      <option value="">— Select item —</option>
                      {barcodeItemNames.map(n => <option key={n} value={n}>{n}</option>)}
                    </select>
                    <select
                      value={r.packaging_raw_material_id}
                      onChange={e => bcReq.set(idx, { packaging_raw_material_id: e.target.value })}
                      disabled={!r.item_name}
                      className={`${fieldBase} flex-1 min-w-0`}
                    >
                      <option value="">— Select variant —</option>
                      {variantOptions.map(a => <option key={a.id} value={a.id}>{a.variant || '— none —'}</option>)}
                    </select>
                    <input
                      type="number"
                      min={1}
                      value={r.qty}
                      onChange={e => bcReq.set(idx, { qty: e.target.value })}
                      placeholder="Qty"
                      className={`${fieldBase} w-24 shrink-0`}
                    />
                    <button
                      type="button"
                      onClick={() => bcReq.remove(idx)}
                      disabled={form.barcode_requirements.length === 1}
                      title="Remove"
                      className="p-1.5 rounded text-red-500 hover:bg-red-50 disabled:opacity-30"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="flex gap-3 justify-end pt-2">
            <Button variant="ghost" type="button" onClick={() => setModal(null)}>Cancel</Button>
            <Button type="submit" loading={saving}>{modal === 'add' ? 'Create SKU' : 'Save Changes'}</Button>
          </div>
        </form>
      </Modal>

      <BulkUploadModal
        isOpen={bulkOpen}
        onClose={() => setBulkOpen(false)}
        onDone={load}
        config={skuUploadConfig}
      />

      <ConfirmDialog
        isOpen={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        onConfirm={handleDelete}
        title="Delete SKU"
        message={`Delete "${confirmDelete?.label}"? Any vendor mappings for this SKU will also be removed.`}
        confirmLabel="Delete SKU"
        loading={saving}
      />

      <ConfirmDialog
        isOpen={confirmBulk}
        onClose={() => setConfirmBulk(false)}
        onConfirm={handleBulkDelete}
        title="Delete SKUs"
        message={`Delete ${sel.selected.size} selected SKU${sel.selected.size !== 1 ? 's' : ''}? Their vendor mappings will also be removed. This cannot be undone.`}
        confirmLabel="Delete"
        loading={saving}
      />
    </>
  );
}

// ─────────────────────────────── Raw Products tab ───────────────────────────────

const EMPTY_RAW = { name: '', qty: 0 };

function RawProductsTab() {
  const { canEdit: canWrite } = useRBAC();

  const [rows, setRows] = useState([]);
  const [search, setSearch] = useSessionState('products.raw.search', '');
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState(EMPTY_RAW);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);

  const sel = useRowSelection(rows);

  const load = () => {
    setLoading(true);
    getRawProducts()
      .then(r => setRows(r.data))
      .catch(() => toast.error('Failed to load raw products'))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    if (!q) return rows;
    return rows.filter(r => (r.name || '').toLowerCase().includes(q));
  }, [search, rows]);

  const openAdd = () => { setForm(EMPTY_RAW); setModal('add'); };
  const openEdit = (r) => { setForm({ name: r.name, qty: r.qty }); setModal({ type: 'edit', id: r.id }); };

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const payload = { name: form.name.trim(), qty: parseInt(form.qty) || 0 };
      if (modal === 'add') {
        await createRawProduct(payload);
        toast.success('Raw product created');
      } else {
        await updateRawProduct(modal.id, payload);
        toast.success('Raw product updated');
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
      await deleteRawProduct(confirmDelete.id);
      toast.success('Raw product deleted');
      setConfirmDelete(null);
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Delete failed');
    } finally { setSaving(false); }
  };

  const handleBulkDelete = async () => {
    setSaving(true);
    try {
      const r = await bulkDeleteRawProducts(Array.from(sel.selected));
      toast.success(`Deleted ${r.data.deleted} raw product${r.data.deleted !== 1 ? 's' : ''}`);
      setConfirmBulk(false);
      sel.clear();
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Delete failed');
    } finally { setSaving(false); }
  };

  const colSpan = 2 + (canWrite ? 2 : 0);

  const downloadXlsx = () => downloadRows('raw-products', [
    { key: 'name', header: 'name' },
    { key: 'qty', header: 'qty' },
  ], rows);

  return (
    <>
      <div className="mb-4 flex items-start justify-between flex-wrap gap-3">
        <p className="text-gray-500 text-sm">{filtered.length} of {rows.length} raw product{rows.length !== 1 ? 's' : ''}</p>
        <div className="flex gap-3 items-center flex-wrap">
          <div className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search raw products…" className="pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f] w-full sm:w-52" />
          </div>
          <Button variant="ghost" onClick={downloadXlsx} disabled={!rows.length}><Download size={16} />Download XLSX</Button>
          {canWrite && <Button variant="ghost" onClick={() => setBulkOpen(true)}><Upload size={16} />Bulk Upload</Button>}
          {canWrite && <Button onClick={openAdd}><Plus size={16} />Add Raw Product</Button>}
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
                {['Name', 'Qty', canWrite ? 'Actions' : ''].filter(Boolean).map(h => (
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
                  <td className="px-4 py-3 font-medium text-gray-900">{r.name}</td>
                  <td className="px-4 py-3 text-gray-700 font-medium">{Number(r.qty ?? 0).toLocaleString('en-IN')}</td>
                  {canWrite && (
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        <button onClick={() => openEdit(r)} className="p-1.5 rounded hover:bg-blue-50 text-blue-500"><Pencil size={14} /></button>
                        <button onClick={() => setConfirmDelete({ id: r.id, name: r.name })} className="p-1.5 rounded hover:bg-red-50 text-red-500"><Trash2 size={14} /></button>
                        <HistoryButton entityType="raw_product" entityId={r.id} title={`History — ${r.name}`} />
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && filtered.length === 0 && (
            <p className="text-center text-gray-400 py-8">{search ? 'No raw products match your search' : 'No raw products added yet'}</p>
          )}
        </div>
      </div>

      <Modal isOpen={!!modal} onClose={() => setModal(null)} title={modal === 'add' ? 'Add Raw Product' : 'Edit Raw Product'} size="md">
        <form onSubmit={handleSave} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Name <span className="text-red-500">*</span></label>
            <input
              required
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder="e.g. Cotton Fabric Roll"
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f]"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Qty</label>
            <input
              type="number"
              min={0}
              value={form.qty}
              onChange={e => setForm(f => ({ ...f, qty: e.target.value }))}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f]"
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
        config={rawUploadConfig}
      />

      <ConfirmDialog
        isOpen={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        onConfirm={handleDelete}
        title="Delete Raw Product"
        message={`Delete "${confirmDelete?.name}"?`}
        confirmLabel="Delete"
        loading={saving}
      />

      <ConfirmDialog
        isOpen={confirmBulk}
        onClose={() => setConfirmBulk(false)}
        onConfirm={handleBulkDelete}
        title="Delete Raw Products"
        message={`Delete ${sel.selected.size} selected raw product${sel.selected.size !== 1 ? 's' : ''}? This cannot be undone.`}
        confirmLabel="Delete"
        loading={saving}
      />
    </>
  );
}
