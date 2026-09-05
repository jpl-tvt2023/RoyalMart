import { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { Plus, Pencil, Power, Trash2, Upload, Download } from 'lucide-react';
import toast from 'react-hot-toast';
import AppShell from '../../components/layout/AppShell';
import Modal from '../../components/ui/Modal';
import Button from '../../components/ui/Button';
import BulkUploadModal from '../products/BulkUploadModal';
import { useRBAC } from '../../hooks/useRBAC';
import { HistoryButton } from '../../components/shared/HistoryDrawer';
import { formatDateTime } from '../../utils/formatters';
import { sortByText } from '../../utils/sort';
import {
  listOutboundVendors, createOutboundVendor, updateOutboundVendor, deleteOutboundVendor,
  bulkUpsertOutboundVendors,
} from '../../api/outboundVendors.api';
import { getPackagingRawMaterials } from '../../api/packagingRawMaterials.api';
import { listOutboundProducts } from '../../api/outboundProducts.api';

const emptyRow = () => ({ category: '', item_name: '', variant: '' });
const emptyForm = () => ({ name: '', is_active: true, articles: [emptyRow()] });

// Export columns match the bulk-upload template so a downloaded file can be
// edited and re-uploaded round-trip (same convention as ProductList).
function downloadRows(filename, columns, rows) {
  const header = columns.map(c => c.header);
  const data = rows.map(r => columns.map(c => (r[c.key] == null ? '' : r[c.key])));
  const ws = XLSX.utils.aoa_to_sheet([header, ...data]);
  ws['!cols'] = header.map(() => ({ wch: 22 }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Export');
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
  XLSX.writeFile(wb, `${filename}-${stamp}.xlsx`);
}

const uploadConfig = {
  title: 'Bulk Upload Outbound Vendors',
  templateFileName: 'outbound-vendors-template.xlsx',
  headers: ['vendor_name', 'category', 'item_name', 'variant'],
  sampleRow: ['Om Sai Packaging', 'Packaging', 'Corrugated', '60'],
  requiredKeys: ['vendor_name', 'category', 'item_name'],
  instructions: 'One row per article mapping. category, item_name and variant must together match an existing product under Configurations → Packaging Items — leave variant blank for an item that has no variants. New vendor names are created automatically; rows matching an existing mapping are skipped — nothing is ever deleted.',
  submit: (rows) => bulkUpsertOutboundVendors(rows),
};

export default function OutboundVendorsPage() {
  const { canEdit } = useRBAC();
  // Master data is open to every logged-in user (add/edit/deactivate); all
  // changes are audited and viewable via the per-row history, same as the
  // inbound Vendors master under Configurations.
  const canAdmin = canEdit;
  const colCount = 5 + (canAdmin ? 1 : 0);

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null); // 'add' | { type: 'edit', id }
  const [form, setForm] = useState(emptyForm());
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [togglingId, setTogglingId] = useState(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [catalogRows, setCatalogRows] = useState([]);
  const [masterRows, setMasterRows] = useState([]);

  const loadCatalog = () => {
    getPackagingRawMaterials()
      .then(r => setCatalogRows(r.data || []))
      .catch(() => {});
  };
  useEffect(loadCatalog, []);

  // The Outbound Product List, for the UM column: since migration 064 a
  // (Category, Item Name) pair can be listed under several metrics, and a PO
  // line mapped to this article picks between them.
  const loadMasterRows = () => {
    listOutboundProducts()
      .then(rows => setMasterRows(rows || []))
      .catch(() => {});
  };
  useEffect(loadMasterRows, []);

  // Category / Item Name / Variant options for the article-mapping sub-form,
  // sourced from the Packaging Products master catalog. The catalog carries one
  // row per variant, so item names have to be de-duplicated here.
  const catalogCategories = useMemo(
    () => sortByText(Array.from(new Set(catalogRows.map(r => r.category)))),
    [catalogRows]
  );
  const itemNamesByCategory = useMemo(() => {
    const map = catalogRows.reduce((acc, r) => {
      (acc[r.category] ||= new Set()).add(r.item_name);
      return acc;
    }, {});
    for (const cat of Object.keys(map)) map[cat] = sortByText(Array.from(map[cat]));
    return map;
  }, [catalogRows]);

  // Variant is a catalog attribute as of migration 056, not free text — the
  // picker offers exactly the variants that exist for the chosen item.
  const variantsByCatItem = useMemo(() => {
    const map = catalogRows.reduce((acc, r) => {
      (acc[`${r.category}|${r.item_name}`] ||= new Set()).add(r.variant || '');
      return acc;
    }, {});
    for (const k of Object.keys(map)) map[k] = sortByText(Array.from(map[k]));
    return map;
  }, [catalogRows]);
  // Every metric a PO line for this article could be raised in — the master's
  // list for the pair, plus the packaging catalog's own value when the master no
  // longer offers it. Same set the API publishes as `unit_metrics` on each
  // mapping, and the same grandfathering, so the two screens agree.
  const unitMetricsFor = (a) => {
    const metrics = [...new Set(
      masterRows
        .filter(m => m.category === a.category && m.item_name === a.item_name)
        .map(m => m.unit_metric)
        .filter(Boolean),
    )];
    const catalogMetric = catalogRows.find(r =>
      r.category === a.category && r.item_name === a.item_name && (r.variant || '') === (a.variant || '')
    )?.unit_metric || '';
    if (catalogMetric && !metrics.some(m => m.toLowerCase() === catalogMetric.toLowerCase())) {
      metrics.push(catalogMetric);
    }
    return metrics;
  };

  // One export row per mapping, headers matching the upload template.
  const downloadXlsx = () => downloadRows('outbound-vendors', [
    { key: 'vendor_name', header: 'vendor_name' },
    { key: 'category', header: 'category' },
    { key: 'item_name', header: 'item_name' },
    { key: 'variant', header: 'variant' },
  ], rows.flatMap(v => v.articles.length
    ? v.articles.map(a => ({ vendor_name: v.name, category: a.category, item_name: a.item_name, variant: a.variant }))
    : [{ vendor_name: v.name, category: '', item_name: '', variant: '' }]
  ));

  const load = () => {
    setLoading(true);
    listOutboundVendors()
      .then(setRows)
      .catch(() => toast.error('Failed to load outbound vendors'))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const openAdd = () => { loadCatalog(); setForm(emptyForm()); setFormError(''); setModal('add'); };
  const openEdit = (r) => {
    loadCatalog();
    setForm({
      name: r.name,
      is_active: !!r.is_active,
      articles: r.articles.length
        ? r.articles.map(a => ({ category: a.category, item_name: a.item_name, variant: a.variant || '' }))
        : [emptyRow()],
    });
    setFormError('');
    setModal({ type: 'edit', id: r.id });
  };

  const updateRow = (idx, patch) => {
    setForm(f => {
      const next = f.articles.slice();
      next[idx] = { ...next[idx], ...patch };
      return { ...f, articles: next };
    });
  };
  const addRow = () => setForm(f => ({ ...f, articles: [...f.articles, emptyRow()] }));
  const removeRow = (idx) => setForm(f => ({ ...f, articles: f.articles.filter((_, i) => i !== idx) }));

  const handleSave = async (e) => {
    e.preventDefault();
    const name = form.name.trim();
    if (!name) { setFormError('Vendor name is required'); return; }
    if (!form.articles.length) { setFormError('Add at least one article mapping'); return; }
    if (form.articles.some(a => !a.category)) { setFormError('Every mapping needs a category'); return; }
    if (form.articles.some(a => !a.item_name?.trim())) { setFormError('Every mapping needs an item name'); return; }

    setSaving(true);
    setFormError('');
    const payload = {
      name,
      articles: form.articles.map(a => ({
        category: a.category,
        item_name: a.item_name.trim(),
        variant: a.variant?.trim() || null,
      })),
    };
    try {
      if (modal === 'add') {
        await createOutboundVendor(payload);
        toast.success('Vendor added');
      } else {
        await updateOutboundVendor(modal.id, { ...payload, is_active: form.is_active });
        toast.success('Vendor updated');
      }
      setModal(null);
      load();
    } catch (err) {
      const msg = err.response?.data?.message || 'Save failed';
      if (err.response?.status === 409 || err.response?.status === 400) setFormError(msg);
      else toast.error(msg);
    } finally { setSaving(false); }
  };

  const toggleActive = async (r) => {
    setTogglingId(r.id);
    try {
      if (r.is_active) await deleteOutboundVendor(r.id);
      else await updateOutboundVendor(r.id, { is_active: true });
      toast.success(r.is_active ? `"${r.name}" deactivated` : `"${r.name}" reactivated`);
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Update failed');
    } finally { setTogglingId(null); }
  };

  return (
    <AppShell>
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-[#003049]">Outbound Vendors</h1>
        <p className="text-gray-500 text-sm">Vendors that receive outbound POs, and what each one can be sent</p>
      </div>

      <div className="mb-4 flex items-start justify-between flex-wrap gap-3">
        <p className="text-gray-500 text-sm">{rows.length} vendors</p>
        <div className="flex gap-2 flex-wrap">
          <Button variant="ghost" onClick={downloadXlsx} disabled={!rows.length}><Download size={16} />Download XLSX</Button>
          {canAdmin && <Button variant="ghost" onClick={() => setBulkOpen(true)}><Upload size={16} />Bulk Upload</Button>}
          {canAdmin && (
            <Button onClick={openAdd}><Plus size={16} />Add Vendor</Button>
          )}
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="px-4 py-3 text-left font-semibold text-gray-600 whitespace-nowrap">#</th>
                <th className="px-4 py-3 text-left font-semibold text-gray-600">Name</th>
                <th className="px-4 py-3 text-left font-semibold text-gray-600">Article Mappings</th>
                <th className="px-4 py-3 text-left font-semibold text-gray-600 whitespace-nowrap">Last Updated</th>
                <th className="px-4 py-3 text-left font-semibold text-gray-600 whitespace-nowrap">Status</th>
                {canAdmin && <th className="px-4 py-3 text-left font-semibold text-gray-600 whitespace-nowrap">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                [...Array(4)].map((_, i) => (
                  <tr key={i}><td colSpan={colCount} className="px-4 py-3"><div className="h-4 bg-gray-100 rounded animate-pulse" /></td></tr>
                ))
              ) : rows.map((r, idx) => (
                <tr key={r.id} className="border-b border-gray-100 hover:bg-gray-50 transition-colors align-top">
                  <td className="px-4 py-3 font-mono text-xs text-gray-500">{idx + 1}</td>
                  <td className="px-4 py-3 text-gray-900 font-medium whitespace-nowrap">{r.name}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {r.articles.map(a => (
                        <span key={a.id} className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-700 border border-gray-200 whitespace-nowrap">
                          {a.category} · {a.item_name}{a.variant ? ` · ${a.variant}` : ''}
                        </span>
                      ))}
                      {r.articles.length === 0 && <span className="text-xs text-gray-400">—</span>}
                    </div>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-xs text-gray-500">
                    {r.updated_at ? (
                      <>
                        <span className="text-gray-700">{r.updated_by_name || '—'}</span>
                        <span className="block text-gray-400">{formatDateTime(r.updated_at)}</span>
                      </>
                    ) : '—'}
                  </td>
                  <td className="px-4 py-3">
                    {r.is_active ? (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-50 text-green-700 border border-green-200">Active</span>
                    ) : (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-500 border border-gray-200">Inactive</span>
                    )}
                  </td>
                  {canAdmin && (
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => openEdit(r)}
                          title="Edit"
                          className="p-1.5 rounded hover:bg-blue-50 text-blue-500"
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          onClick={() => toggleActive(r)}
                          disabled={togglingId === r.id}
                          title={r.is_active ? 'Deactivate' : 'Reactivate'}
                          className={`p-1.5 rounded disabled:opacity-40 ${r.is_active ? 'hover:bg-red-50 text-red-500' : 'hover:bg-green-50 text-green-600'}`}
                        >
                          <Power size={14} />
                        </button>
                        <HistoryButton entityType="outbound_vendor" entityId={r.id} title="Vendor history" />
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && rows.length === 0 && (
            <p className="text-center text-gray-400 py-8">No outbound vendors yet</p>
          )}
        </div>
      </div>

      <Modal
        isOpen={!!modal}
        onClose={() => setModal(null)}
        title={modal === 'add' ? 'Add Outbound Vendor' : 'Edit Outbound Vendor'}
        size="lg"
      >
        <form onSubmit={handleSave} className="space-y-5">
          <div className="flex items-end gap-4 flex-wrap">
            <div className="flex-1 min-w-[220px]">
              <label className="block text-sm font-medium text-gray-700 mb-1">Vendor Name <span className="text-red-500">*</span></label>
              <input
                autoFocus
                required
                value={form.name}
                onChange={e => { setForm(f => ({ ...f, name: e.target.value })); if (formError) setFormError(''); }}
                placeholder="e.g. Reliance Retail"
                className={inputCls}
              />
            </div>
            {modal !== 'add' && (
              <label className="flex items-center gap-2 text-sm text-gray-700 pb-2">
                <input
                  type="checkbox"
                  checked={form.is_active}
                  onChange={e => setForm(f => ({ ...f, is_active: e.target.checked }))}
                />
                Active
              </label>
            )}
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-[#003049]">Article Mappings ({form.articles.length})</h3>
              <Button type="button" variant="ghost" onClick={addRow}><Plus size={14} />Add Mapping</Button>
            </div>
            {catalogCategories.length === 0 && (
              <p className="text-xs text-amber-600 mb-2">No packaging products exist yet — add them under Configurations → Packaging Items first.</p>
            )}
            <div className="overflow-x-auto bg-white border border-gray-200 rounded-lg">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    <th className="px-3 py-2 text-left font-semibold text-gray-600 w-40">Category</th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-600">Item Name</th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-600">Variant</th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-600 w-20">UM</th>
                    <th className="px-3 py-2 w-12" />
                  </tr>
                </thead>
                <tbody>
                  {form.articles.map((a, idx) => {
                    const variantOptions = variantsByCatItem[`${a.category}|${a.item_name}`] || [];
                    // Defensive: a stored variant that predates the catalog
                    // (or whose catalog row was deleted) stays selectable so
                    // editing an unrelated field can't silently drop it.
                    const orphanVariant = a.variant && !variantOptions.includes(a.variant);
                    return (
                    <tr key={idx} className="border-b border-gray-100">
                      <td className="px-3 py-2">
                        <select
                          value={a.category}
                          onChange={e => updateRow(idx, { category: e.target.value, item_name: '', variant: '' })}
                          className={cellCls}
                        >
                          <option value="">Select category...</option>
                          {catalogCategories.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                      </td>
                      <td className="px-3 py-2">
                        <select
                          value={a.item_name}
                          onChange={e => updateRow(idx, { item_name: e.target.value, variant: '' })}
                          disabled={!a.category}
                          className={cellCls}
                        >
                          <option value="">Select...</option>
                          {(itemNamesByCategory[a.category] || []).map(n => <option key={n} value={n}>{n}</option>)}
                        </select>
                      </td>
                      <td className="px-3 py-2">
                        <select
                          value={a.variant || ''}
                          onChange={e => updateRow(idx, { variant: e.target.value })}
                          disabled={!a.item_name}
                          className={cellCls}
                        >
                          {/* When every catalog row for this item has a real variant (no
                              blank/"no variant" row), a fresh a.variant of '' matches no
                              <option>, and the browser silently displays the first real
                              variant without ever firing onChange -- the form keeps
                              believing variant is '' while the UI shows one picked. An
                              explicit placeholder gives '' something to genuinely match. */}
                          {!variantOptions.includes('') && <option value="">Select variant...</option>}
                          {variantOptions.map(v => <option key={v} value={v}>{v || '— none —'}</option>)}
                          {orphanVariant && <option value={a.variant}>{a.variant} (not in catalog)</option>}
                        </select>
                      </td>
                      <td className="px-3 py-2 text-gray-500 text-xs">{unitMetricsFor(a).join(' / ') || '—'}</td>
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          onClick={() => removeRow(idx)}
                          disabled={form.articles.length === 1}
                          title="Remove mapping"
                          className="p-1.5 rounded hover:bg-red-50 text-red-500 disabled:opacity-30 disabled:hover:bg-transparent"
                        >
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {formError && <p className="text-xs text-red-600">{formError}</p>}

          <div className="flex gap-3 justify-end pt-2">
            <Button variant="ghost" type="button" onClick={() => setModal(null)}>Cancel</Button>
            <Button type="submit" loading={saving}>{modal === 'add' ? 'Add Vendor' : 'Save Changes'}</Button>
          </div>
        </form>
      </Modal>

      <BulkUploadModal
        isOpen={bulkOpen}
        onClose={() => setBulkOpen(false)}
        onDone={load}
        config={uploadConfig}
      />
    </AppShell>
  );
}

const inputCls = 'w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f]';
const cellCls = 'w-full px-2 py-1 border border-gray-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-[#c1121f]/40 focus:border-[#c1121f]';
