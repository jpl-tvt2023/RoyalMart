import { useEffect, useState } from 'react';
import { Plus, Pencil, Power, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import AppShell from '../../components/layout/AppShell';
import Modal from '../../components/ui/Modal';
import Button from '../../components/ui/Button';
import { useRBAC } from '../../hooks/useRBAC';
import { HistoryButton } from '../../components/shared/HistoryDrawer';
import { formatDateTime } from '../../utils/formatters';
import { CATEGORIES, ITEM_NAME_OPTIONS } from '../../constants/outboundArticles';
import {
  listOutboundVendors, createOutboundVendor, updateOutboundVendor, deleteOutboundVendor,
} from '../../api/outboundVendors.api';

const emptyRow = () => ({ category: 'Raw Material', item_name: '', variant: '' });
const emptyForm = () => ({ name: '', is_active: true, articles: [emptyRow()] });

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

  const load = () => {
    setLoading(true);
    listOutboundVendors()
      .then(setRows)
      .catch(() => toast.error('Failed to load outbound vendors'))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const openAdd = () => { setForm(emptyForm()); setFormError(''); setModal('add'); };
  const openEdit = (r) => {
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
        {canAdmin && (
          <Button onClick={openAdd}><Plus size={16} />Add Vendor</Button>
        )}
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
            <div className="overflow-x-auto bg-white border border-gray-200 rounded-lg">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    <th className="px-3 py-2 text-left font-semibold text-gray-600 w-40">Category</th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-600">Item Name</th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-600">Variant</th>
                    <th className="px-3 py-2 w-12" />
                  </tr>
                </thead>
                <tbody>
                  {form.articles.map((a, idx) => (
                    <tr key={idx} className="border-b border-gray-100">
                      <td className="px-3 py-2">
                        <select
                          value={a.category}
                          onChange={e => updateRow(idx, { category: e.target.value, item_name: '' })}
                          className={cellCls}
                        >
                          {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                      </td>
                      <td className="px-3 py-2">
                        {ITEM_NAME_OPTIONS[a.category] ? (
                          <select value={a.item_name} onChange={e => updateRow(idx, { item_name: e.target.value })} className={cellCls}>
                            <option value="">Select...</option>
                            {ITEM_NAME_OPTIONS[a.category].map(n => <option key={n} value={n}>{n}</option>)}
                          </select>
                        ) : (
                          <input
                            value={a.item_name}
                            onChange={e => updateRow(idx, { item_name: e.target.value })}
                            placeholder="e.g. Wooden Pallet"
                            className={cellCls}
                          />
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <input
                          value={a.variant}
                          onChange={e => updateRow(idx, { variant: e.target.value })}
                          placeholder="optional"
                          className={cellCls}
                        />
                      </td>
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
                  ))}
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
    </AppShell>
  );
}

const inputCls = 'w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f]';
const cellCls = 'w-full px-2 py-1 border border-gray-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-[#c1121f]/40 focus:border-[#c1121f]';
