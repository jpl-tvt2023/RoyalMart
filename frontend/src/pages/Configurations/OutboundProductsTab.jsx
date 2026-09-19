import { useEffect, useMemo, useState } from 'react';
import { Plus, Pencil, Power } from 'lucide-react';
import toast from 'react-hot-toast';
import Modal from '../../components/ui/Modal';
import Button from '../../components/ui/Button';
import { useRBAC } from '../../hooks/useRBAC';
import { HistoryButton } from '../../components/shared/HistoryDrawer';
import { formatDateTime } from '../../utils/formatters';
import {
  listOutboundProducts, createOutboundProduct, updateOutboundProduct, deleteOutboundProduct,
} from '../../api/outboundProducts.api';

// The Outbound Product List: the Category / Item Name / Unit Metric taxonomy
// that drives the dropdowns when packaging products are onboarded on
// Configurations -> Packaging Items. Rendered as a tab of Admin -> Purchase
// Config, which owns the page shell and heading. MasterTab cannot be reused
// here -- it is built around a
// single `name` field -- so this mirrors its layout and behaviour instead.

const EMPTY = { category: '', item_name: '', unit_metric: '', is_active: true, goes_to_stitching: false };

const inputCls = 'w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f] disabled:bg-gray-50 disabled:text-gray-500';

export default function OutboundProductsTab() {
  const { canEdit: canAdmin } = useRBAC();
  // # + Category + Item Name + Unit Metric + Products Using + Last Updated + Status
  const colCount = 8 + (canAdmin ? 1 : 0);

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [togglingId, setTogglingId] = useState(null);

  const load = () => {
    setLoading(true);
    listOutboundProducts()
      .then(setRows)
      .catch(() => toast.error('Failed to load the outbound product list'))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  // Autocomplete off the values already in use, so a new category or metric is
  // still possible but the existing ones are one keystroke away.
  const categoryOptions = useMemo(
    () => [...new Set(rows.map(r => r.category).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [rows],
  );
  const metricOptions = useMemo(
    () => [...new Set(rows.map(r => r.unit_metric).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [rows],
  );

  const openAdd = () => { setForm(EMPTY); setFormError(''); setModal('add'); };
  const openEdit = (r) => {
    setForm({
      category: r.category,
      item_name: r.item_name,
      unit_metric: r.unit_metric,
      is_active: !!r.is_active,
      goes_to_stitching: !!r.goes_to_stitching,
      products_using: r.products_using || 0,
    });
    setFormError('');
    setModal({ type: 'edit', id: r.id });
  };

  // Renaming the identity pair would orphan the packaging products onboarded
  // under it, so the backend rejects it while any exist -- mirror that here.
  const identityLocked = modal !== 'add' && (form.products_using || 0) > 0;

  const handleSave = async (e) => {
    e.preventDefault();
    const payload = {
      category: form.category.trim(),
      item_name: form.item_name.trim(),
      unit_metric: form.unit_metric.trim(),
      goes_to_stitching: form.goes_to_stitching,
    };
    if (!payload.category) { setFormError('Category is required'); return; }
    if (!payload.item_name) { setFormError('Item name is required'); return; }
    if (!payload.unit_metric) { setFormError('Unit metric is required'); return; }
    setSaving(true);
    setFormError('');
    try {
      if (modal === 'add') {
        await createOutboundProduct(payload);
        toast.success('Outbound product added');
      } else {
        await updateOutboundProduct(modal.id, { ...payload, is_active: form.is_active });
        toast.success('Outbound product updated');
      }
      setModal(null);
      load();
    } catch (err) {
      const msg = err.response?.data?.message || 'Save failed';
      if (err.response?.status === 409) setFormError(msg);
      else toast.error(msg);
    } finally { setSaving(false); }
  };

  const toggleActive = async (r) => {
    setTogglingId(r.id);
    try {
      if (r.is_active) await deleteOutboundProduct(r.id);
      else await updateOutboundProduct(r.id, { is_active: true });
      const label = `${r.category} / ${r.item_name}`;
      toast.success(r.is_active ? `"${label}" deactivated` : `"${label}" reactivated`);
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Update failed');
    } finally { setTogglingId(null); }
  };

  return (
    <>
      <div className="mb-4 flex items-start justify-between flex-wrap gap-3">
        <p className="text-gray-500 text-sm">
          {rows.length} product{rows.length !== 1 ? 's' : ''} — the Category, Item Name and Unit Metric options offered when onboarding on Packaging Items
        </p>
        {canAdmin && <Button onClick={openAdd}><Plus size={16} />Add Outbound Product</Button>}
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="px-4 py-3 text-left font-semibold text-gray-600 whitespace-nowrap">#</th>
                <th className="px-4 py-3 text-left font-semibold text-gray-600 whitespace-nowrap">Category</th>
                <th className="px-4 py-3 text-left font-semibold text-gray-600 whitespace-nowrap">Item Name</th>
                <th className="px-4 py-3 text-left font-semibold text-gray-600 whitespace-nowrap">Unit Metric</th>
                <th className="px-4 py-3 text-left font-semibold text-gray-600 whitespace-nowrap">Stitching</th>
                <th className="px-4 py-3 text-left font-semibold text-gray-600 whitespace-nowrap">Products Using</th>
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
                <tr key={r.id} className="border-b border-gray-100 hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3 font-mono text-xs text-gray-500">{idx + 1}</td>
                  <td className="px-4 py-3 text-gray-700">{r.category}</td>
                  <td className="px-4 py-3 text-gray-900 font-medium">{r.item_name}</td>
                  <td className="px-4 py-3 text-gray-700">{r.unit_metric}</td>
                  {/* Only these articles travel the Stitching stages, and only
                      their receipts demand a stage and a metres figure. */}
                  <td className="px-4 py-3 text-gray-700">
                    {r.goes_to_stitching
                      ? <span className="text-[#003049] font-medium">Yes</span>
                      : <span className="text-gray-300">—</span>}
                  </td>
                  {/* Derived count, not a stored field — a native title is used
                      rather than a popover because this table sits in an
                      overflow-auto container that would clip one. */}
                  <td className="px-4 py-3">
                    <span
                      title={r.products_using ? `${r.products_using} packaging product${r.products_using !== 1 ? 's' : ''} onboarded under this entry` : 'Not used by any packaging product yet'}
                      className={r.products_using ? 'text-gray-700 cursor-help underline decoration-dotted underline-offset-2' : 'text-gray-400'}
                    >
                      {r.products_using ?? 0}
                    </span>
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
                        <HistoryButton entityType="outbound_product" entityId={r.id} title={`History — ${r.category} / ${r.item_name}`} />
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && rows.length === 0 && (
            <p className="text-center text-gray-400 py-8">No outbound products yet</p>
          )}
        </div>
      </div>

      <Modal
        isOpen={!!modal}
        onClose={() => setModal(null)}
        title={modal === 'add' ? 'Add Outbound Product' : 'Edit Outbound Product'}
        size="sm"
      >
        <form onSubmit={handleSave} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Category <span className="text-red-500">*</span></label>
            <input
              autoFocus={modal === 'add'}
              required
              disabled={identityLocked}
              list="outbound-product-category-options"
              value={form.category}
              onChange={e => { setForm(f => ({ ...f, category: e.target.value })); if (formError) setFormError(''); }}
              placeholder="e.g. Raw Material, Packaging, Barcode"
              className={inputCls}
            />
            <datalist id="outbound-product-category-options">
              {categoryOptions.map(c => <option key={c} value={c} />)}
            </datalist>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Item Name <span className="text-red-500">*</span></label>
            <input
              required
              disabled={identityLocked}
              value={form.item_name}
              onChange={e => { setForm(f => ({ ...f, item_name: e.target.value })); if (formError) setFormError(''); }}
              placeholder="e.g. Corrugated"
              className={inputCls}
            />
          </div>

          {identityLocked && (
            <p className="text-xs text-gray-500">
              {form.products_using} packaging product{form.products_using !== 1 ? 's' : ''} already use this entry, so the category and item name are locked. Deactivate it instead, or rename those products first.
            </p>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Unit Metric <span className="text-red-500">*</span></label>
            <input
              required
              list="outbound-product-metric-options"
              value={form.unit_metric}
              onChange={e => { setForm(f => ({ ...f, unit_metric: e.target.value })); if (formError) setFormError(''); }}
              placeholder="e.g. kg, pcs, meter, roll"
              className={inputCls}
            />
            <datalist id="outbound-product-metric-options">
              {metricOptions.map(m => <option key={m} value={m} />)}
            </datalist>
            {identityLocked && (
              <p className="mt-1 text-xs text-gray-500">
                Changing this also updates the {form.products_using} packaging product{form.products_using !== 1 ? 's' : ''} using it. Existing PO lines keep the metric they were raised with.
              </p>
            )}
          </div>

          {formError && <p className="text-xs text-red-600">{formError}</p>}

          <label className="flex items-start gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={form.goes_to_stitching}
              onChange={e => setForm(f => ({ ...f, goes_to_stitching: e.target.checked }))}
            />
            <span>
              Goes through Stitching
              <span className="block text-[11px] text-gray-400">
                Fabric only. Its receipts ask for the stage the goods arrived at and their
                quantity in metres, and its lots appear on the Stitching page.
              </span>
            </span>
          </label>

          {modal !== 'add' && (
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={form.is_active}
                onChange={e => setForm(f => ({ ...f, is_active: e.target.checked }))}
              />
              Active
            </label>
          )}

          <div className="flex gap-3 justify-end pt-2">
            <Button variant="ghost" type="button" onClick={() => setModal(null)}>Cancel</Button>
            <Button type="submit" loading={saving}>{modal === 'add' ? 'Add Outbound Product' : 'Save Changes'}</Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
