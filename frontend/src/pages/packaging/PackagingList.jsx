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
import { listOutboundProducts } from '../../api/outboundProducts.api';
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

// unit_metric stays in the template columns so a downloaded export can be
// edited and re-uploaded round-trip. The Outbound Product List still owns the
// value; the column is only read to choose between metrics when an item is
// listed under more than one.
const rawMaterialUploadConfig = {
  title: 'Bulk Upload Packaging Products',
  templateFileName: 'packaging-products-template.xlsx',
  headers: ['category', 'item_name', 'variant', 'unit_metric'],
  sampleRow: ['Packaging', 'Corrugated', '5 Ply', 'pcs'],
  requiredKeys: ['category', 'item_name'],
  instructions: 'Category + Item Name must already exist in Admin → Purchase Config → Outbound Product List; rows that do not match are skipped. Variant is optional — leave it blank for an item that has no variants. The unit metric is taken from the Outbound Product List, so that column is normally ignored — fill it in only when an item is listed there under more than one metric, to say which one applies. Rows whose Category + Item Name + Variant match an existing product are updated, new combinations are added.',
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
  const [masterRows, setMasterRows] = useState([]);
  const [search, setSearch] = useSessionState('packaging.catalog.search', '');
  const [activeCategory, setActiveCategory] = useSessionState('packaging.catalog.category', '');
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState(EMPTY_RAW_MATERIAL);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);

  const load = () => {
    setLoading(true);
    getPackagingRawMaterials()
      .then(r => setRows(r.data))
      .catch(() => toast.error('Failed to load packaging products'))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  // The Outbound Product List drives the Category / Item Name pickers and the
  // unit metric. The endpoint returns deactivated entries too (the config tab
  // shows them); they must not be offered here.
  const loadMasterRows = () => {
    listOutboundProducts()
      .then(r => setMasterRows((r || []).filter(m => m.is_active)))
      .catch(() => toast.error('Failed to load the outbound product list'));
  };
  useEffect(loadMasterRows, []);

  const searchMatched = useMemo(() => {
    const q = search.toLowerCase();
    if (!q) return rows;
    return rows.filter(r =>
      (r.category || '').toLowerCase().includes(q) ||
      (r.item_name || '').toLowerCase().includes(q) ||
      (r.variant || '').toLowerCase().includes(q) ||
      (r.unit_metric || '').toLowerCase().includes(q)
    );
  }, [search, rows]);

  // One tab per category actually present in the catalog — never a hardcoded
  // list, so a category added to the Outbound Product List gets a tab the
  // moment its first product is onboarded. Derived from all rows rather than
  // the search results, so tabs don't appear and vanish while typing.
  const categoryTabs = useMemo(() => {
    const counts = rows.reduce((acc, r) => {
      if (r.category) acc[r.category] = (acc[r.category] || 0) + 1;
      return acc;
    }, {});
    return Object.entries(counts)
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => {
        // Others is pinned last whatever its size; the rest are largest first,
        // ties broken alphabetically so the order stays stable.
        const aOther = a.category.toLowerCase() === 'others';
        const bOther = b.category.toLowerCase() === 'others';
        if (aOther !== bOther) return aOther ? 1 : -1;
        return b.count - a.count || a.category.localeCompare(b.category);
      });
  }, [rows]);

  // Match counts per tab, so a search shows at a glance which tab the hits are
  // in instead of the current tab just looking empty.
  const matchesByCategory = useMemo(() => searchMatched.reduce((acc, r) => {
    acc[r.category] = (acc[r.category] || 0) + 1;
    return acc;
  }, {}), [searchMatched]);

  // Fall back to the first tab whenever the remembered category no longer
  // exists — first load, or its last product deleted/recategorised.
  useEffect(() => {
    if (!categoryTabs.length) return;
    if (!categoryTabs.some(t => t.category === activeCategory)) {
      setActiveCategory(categoryTabs[0].category);
    }
  }, [categoryTabs, activeCategory, setActiveCategory]);

  const visible = useMemo(
    () => searchMatched.filter(r => r.category === activeCategory),
    [searchMatched, activeCategory],
  );

  const categoryTotal = categoryTabs.find(t => t.category === activeCategory)?.count || 0;

  // Selection is scoped to what is on screen, so "select all" means "all
  // visible" and a bulk delete can never reach rows in another tab.
  const sel = useRowSelection(visible);

  const switchCategory = (category) => {
    if (category === activeCategory) return;
    sel.clear();
    setActiveCategory(category);
  };

  // Category / Item Name / Unit Metric all come from the Outbound Product List
  // rather than being typed here, which is what stops "Packaging" fragmenting
  // into "packaging" / "Packageing" and splitting the catalog. Same option-map
  // shape as the article sub-form on the Outbound Vendors page.
  const masterCategories = useMemo(
    () => [...new Set(masterRows.map(m => m.category).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [masterRows],
  );

  const itemNamesByCategory = useMemo(() => {
    const map = masterRows.reduce((acc, m) => {
      (acc[m.category] ||= new Set()).add(m.item_name);
      return acc;
    }, {});
    for (const cat of Object.keys(map)) map[cat] = [...map[cat]].sort((a, b) => a.localeCompare(b));
    return map;
  }, [masterRows]);

  // Since migration 064 a pair can be listed under several unit metrics (the
  // "Barcode / Barcode" in pcs and in mtr case), so this returns all of them.
  // One option means the metric is still decided entirely by the master and the
  // field stays read-only -- only a genuinely ambiguous pair asks the user.
  const unitMetricsFor = (category, itemName) => [...new Set(
    masterRows
      .filter(m => m.category === category && m.item_name === itemName)
      .map(m => m.unit_metric)
      .filter(Boolean),
  )];

  const unitMetricFor = (category, itemName) => {
    const options = unitMetricsFor(category, itemName);
    return options.length === 1 ? options[0] : '';
  };

  const metricOptions = unitMetricsFor(form.category, form.item_name);
  const metricIsAmbiguous = metricOptions.length > 1;

  // A product onboarded before its entry was deactivated or renamed keeps that
  // value selectable, so the row stays editable instead of silently resetting.
  const orphanCategory = !!form.category && !masterCategories.includes(form.category);
  const orphanItemName = !!form.item_name && !(itemNamesByCategory[form.category] || []).includes(form.item_name);

  // Prefill the category from the tab being viewed — that is almost always the
  // one being added to, and it keeps the new row on screen after saving.
  const openAdd = () => {
    loadMasterRows();
    const preset = masterCategories.includes(activeCategory) ? activeCategory : '';
    setForm({ ...EMPTY_RAW_MATERIAL, category: preset });
    setModal('add');
  };
  const openEdit = (r) => {
    loadMasterRows();
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
      // Follow the saved row if it landed in another category, so it is not
      // saved "into thin air" from the user's point of view.
      if (payload.category !== activeCategory) switchCategory(payload.category);
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
  const colSpan = 4 + (canWrite ? 2 : 0);

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
        <p className="text-gray-500 text-sm">
          {activeCategory
            ? <>{visible.length} of {categoryTotal} in {activeCategory} · {rows.length} total</>
            : <>{rows.length} product{rows.length !== 1 ? 's' : ''}</>}
        </p>
        <div className="flex gap-3 items-center flex-wrap">
          <div className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search packaging products…" className="pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f] w-full sm:w-52" />
          </div>
          <Button variant="ghost" onClick={downloadXlsx} disabled={!rows.length}><Download size={16} />Download XLSX</Button>
          {canWrite && <Button variant="ghost" onClick={() => setBulkOpen(true)}><Upload size={16} />Bulk Upload</Button>}
          {canWrite && (
            <Button
              onClick={openAdd}
              disabled={masterRows.length === 0}
              title={masterRows.length === 0 ? 'Add entries to the Outbound Product List first' : undefined}
            >
              <Plus size={16} />Add Packaging Product
            </Button>
          )}
        </div>
      </div>

      {canWrite && masterRows.length === 0 && (
        <p className="mb-4 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
          The Outbound Product List is empty — add categories and items under Admin → Purchase Config → Outbound Product List before onboarding packaging products.
        </p>
      )}

      {categoryTabs.length > 0 && (
        <div className="flex gap-1 mb-4 border-b border-gray-200 overflow-x-auto">
          {categoryTabs.map(t => {
            const matches = search ? (matchesByCategory[t.category] || 0) : t.count;
            const dimmed = !!search && matches === 0;
            return (
              <button
                key={t.category}
                type="button"
                onClick={() => switchCategory(t.category)}
                className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap ${
                  t.category === activeCategory
                    ? 'border-[#c1121f] text-[#c1121f]'
                    : `border-transparent hover:text-[#003049] ${dimmed ? 'text-gray-300' : 'text-gray-500'}`
                }`}
              >
                {t.category} ({matches})
              </button>
            );
          })}
        </div>
      )}

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
                {/* No Category column — the active tab already states it. */}
                {['Item Name', 'Variant', 'Unit Metric', 'Vendors Mapped', canWrite ? 'Actions' : ''].filter(Boolean).map(h => (
                  <th key={h} className="px-4 py-3 text-left font-semibold text-gray-600 whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                [...Array(5)].map((_, i) => (
                  <tr key={i}><td colSpan={colSpan} className="px-4 py-3"><div className="h-4 bg-gray-100 rounded animate-pulse" /></td></tr>
                ))
              ) : visible.map(r => (
                <tr key={r.id} className="border-b border-gray-100 hover:bg-gray-50 transition-colors">
                  {canWrite && (
                    <td className="px-4 py-3">
                      <input type="checkbox" checked={sel.selected.has(r.id)} onChange={() => sel.toggle(r.id)} />
                    </td>
                  )}
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
          {!loading && visible.length === 0 && (
            <p className="text-center text-gray-400 py-8">
              {rows.length === 0
                ? 'No packaging products added yet'
                : search
                  ? `No packaging products in ${activeCategory} match your search`
                  : `No packaging products in ${activeCategory} yet`}
            </p>
          )}
        </div>
      </div>

      <Modal isOpen={!!modal} onClose={() => setModal(null)} title={modal === 'add' ? 'Add Packaging Product' : 'Edit Packaging Product'} size="md">
        <form onSubmit={handleSave} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Category <span className="text-red-500">*</span></label>
            <select
              required
              value={form.category}
              onChange={e => setForm(f => ({ ...f, category: e.target.value, item_name: '', unit_metric: '' }))}
              className={inputCls}
            >
              <option value="">Select category…</option>
              {masterCategories.map(c => <option key={c} value={c}>{c}</option>)}
              {/* An entry deactivated (or renamed) after this product was
                  onboarded stays selectable so the row remains editable. */}
              {orphanCategory && <option value={form.category}>{form.category} (not in Outbound Product List)</option>}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Item Name <span className="text-red-500">*</span></label>
            <select
              required
              disabled={!form.category}
              value={form.item_name}
              onChange={e => setForm(f => ({ ...f, item_name: e.target.value, unit_metric: unitMetricFor(f.category, e.target.value) }))}
              className={inputCls}
            >
              <option value="">Select item…</option>
              {(itemNamesByCategory[form.category] || []).map(n => <option key={n} value={n}>{n}</option>)}
              {orphanItemName && <option value={form.item_name}>{form.item_name} (not in Outbound Product List)</option>}
            </select>
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
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Unit Metric {metricIsAmbiguous && <span className="text-red-500">*</span>}
            </label>
            {metricIsAmbiguous ? (
              /* The item is listed under more than one metric, so the master
                 cannot decide this one -- the user picks between its options. */
              <select
                required
                value={form.unit_metric}
                onChange={e => setForm(f => ({ ...f, unit_metric: e.target.value }))}
                className={inputCls}
              >
                <option value="">Select unit metric…</option>
                {metricOptions.map(u => <option key={u} value={u}>{u}</option>)}
              </select>
            ) : (
              /* Read-only: the metric belongs to the item in the Outbound Product
                 List, and the server takes it from there regardless of what is
                 submitted here. Change it on that tab to change it everywhere. */
              <input
                readOnly
                value={form.unit_metric}
                placeholder={form.item_name ? '—' : 'Set by the selected item'}
                className={`${inputCls} bg-gray-50 text-gray-600`}
              />
            )}
            <p className="mt-1 text-xs text-gray-400">
              {metricIsAmbiguous
                ? 'This item is listed under more than one unit metric on Admin → Purchase Config → Outbound Product List'
                : 'Set on Admin → Purchase Config → Outbound Product List'}
            </p>
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
