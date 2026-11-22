import { useEffect, useState } from 'react';
import { Plus, Pencil, Power } from 'lucide-react';
import toast from 'react-hot-toast';
import Modal from '../../components/ui/Modal';
import Button from '../../components/ui/Button';
import { useRBAC } from '../../hooks/useRBAC';
import { HistoryButton } from '../../components/shared/HistoryDrawer';
import { formatDateTime } from '../../utils/formatters';

// Shared CRUD UI for any simple master with { id, name, is_active } shape.
// Cities, Vendors, and Couriers all conform to it; Vendors adds an extra
// read-only "Parser" column via the `extraColumn` prop, and one more editable
// field -- its PO Prefix -- via `extraField`:
//   { key, label, required, placeholder, normalize(v), defaultFrom(name),
//     lockedWhen(row), hint, lockedHint }
// `defaultFrom` pre-fills the field on Add from the name until the user types
// in it, and `lockedWhen` shows it read-only on Edit (and leaves it out of the
// save).

const EMPTY = { name: '', is_active: true };

export default function MasterTab({
  label,
  labelPlural,
  entityType,
  listFn, createFn, updateFn, deleteFn,
  extraColumn,
  extraField,
}) {
  const { canEdit } = useRBAC();
  // Master data is open to every logged-in user (add/edit/deactivate); all
  // changes are audited and viewable via the per-row history.
  const canAdmin = canEdit;
  // # + Name + Last Updated + Status, plus optional extra-field, Parser and
  // Actions columns.
  const colCount = 4 + (extraField ? 1 : 0) + (extraColumn ? 1 : 0) + (canAdmin ? 1 : 0);

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [togglingId, setTogglingId] = useState(null);
  // Whether the user has typed in the extra field, which stops `defaultFrom`.
  const [extraTouched, setExtraTouched] = useState(false);
  const extraKey = extraField?.key;
  const norm = (v) => (extraField?.normalize ? extraField.normalize(v) : v);
  const extraLocked = !!(extraField && modal && modal !== 'add' && modal.locked);

  const load = () => {
    setLoading(true);
    listFn()
      .then(setRows)
      .catch(() => toast.error(`Failed to load ${labelPlural}`))
      .finally(() => setLoading(false));
  };
  useEffect(load, [listFn]);

  const openAdd = () => {
    setForm(extraField ? { ...EMPTY, [extraKey]: '' } : EMPTY);
    setExtraTouched(false);
    setFormError('');
    setModal('add');
  };
  const openEdit = (r) => {
    setForm({ name: r.name, is_active: !!r.is_active, ...(extraField ? { [extraKey]: r[extraKey] || '' } : {}) });
    setExtraTouched(true);
    setFormError('');
    setModal({ type: 'edit', id: r.id, locked: !!(extraField?.lockedWhen && extraField.lockedWhen(r)) });
  };

  const handleSave = async (e) => {
    e.preventDefault();
    const name = form.name.trim();
    if (!name) { setFormError('Name is required'); return; }
    const extra = extraField ? String(form[extraKey] || '').trim() : '';
    if (extraField?.required && modal === 'add' && !extra) {
      setFormError(`${extraField.label} is required`);
      return;
    }
    // A locked field is left out, so the save cannot touch it.
    const extraBody = extraField && !extraLocked ? { [extraKey]: extra } : {};
    setSaving(true);
    setFormError('');
    try {
      if (modal === 'add') {
        await createFn({ name, ...extraBody });
        toast.success(`${label} added`);
      } else {
        await updateFn(modal.id, { name, is_active: form.is_active, ...extraBody });
        toast.success(`${label} updated`);
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
      if (r.is_active) await deleteFn(r.id);
      else await updateFn(r.id, { is_active: true });
      toast.success(r.is_active ? `"${r.name}" deactivated` : `"${r.name}" reactivated`);
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Update failed');
    } finally { setTogglingId(null); }
  };

  return (
    <>
      <div className="mb-4 flex items-start justify-between flex-wrap gap-3">
        <p className="text-gray-500 text-sm">{rows.length} {labelPlural}</p>
        {canAdmin && (
          <Button onClick={openAdd}><Plus size={16} />Add {label}</Button>
        )}
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="px-4 py-3 text-left font-semibold text-gray-600 whitespace-nowrap">#</th>
                <th className="px-4 py-3 text-left font-semibold text-gray-600">Name</th>
                {extraField && (
                  <th className="px-4 py-3 text-left font-semibold text-gray-600 whitespace-nowrap">{extraField.label}</th>
                )}
                {extraColumn && (
                  <th className="px-4 py-3 text-left font-semibold text-gray-600 whitespace-nowrap">{extraColumn.header}</th>
                )}
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
                  <td className="px-4 py-3 text-gray-900 font-medium">{r.name}</td>
                  {extraField && (
                    <td className="px-4 py-3 font-mono text-xs text-gray-700">{r[extraKey] || '—'}</td>
                  )}
                  {extraColumn && (
                    <td className="px-4 py-3">{extraColumn.render(r)}</td>
                  )}
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
                        <HistoryButton entityType={entityType} entityId={r.id} title={`${label} history`} />
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && rows.length === 0 && (
            <p className="text-center text-gray-400 py-8">No {labelPlural} yet</p>
          )}
        </div>
      </div>

      <Modal
        isOpen={!!modal}
        onClose={() => setModal(null)}
        title={modal === 'add' ? `Add ${label}` : `Edit ${label}`}
        size="sm"
      >
        <form onSubmit={handleSave} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Name <span className="text-red-500">*</span></label>
            <input
              autoFocus
              required
              value={form.name}
              onChange={e => {
                const nextName = e.target.value;
                setForm(f => ({
                  ...f,
                  name: nextName,
                  ...(extraField?.defaultFrom && modal === 'add' && !extraTouched
                    ? { [extraKey]: norm(extraField.defaultFrom(nextName)) } : {}),
                }));
                if (formError) setFormError('');
              }}
              placeholder={`e.g. ${label === 'City' ? 'Pune' : label === 'Vendor' ? 'Zomato' : 'Delhivery'}`}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f]"
            />
            {formError && !extraField && <p className="mt-1 text-xs text-red-600">{formError}</p>}
          </div>

          {extraField && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {extraField.label} {extraField.required && <span className="text-red-500">*</span>}
              </label>
              <input
                value={form[extraKey] || ''}
                disabled={extraLocked}
                onChange={e => {
                  setExtraTouched(true);
                  setForm(f => ({ ...f, [extraKey]: norm(e.target.value) }));
                  if (formError) setFormError('');
                }}
                placeholder={extraField.placeholder}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f] disabled:bg-gray-50 disabled:text-gray-500"
              />
              {(extraLocked ? extraField.lockedHint : extraField.hint) && (
                <p className="mt-1 text-xs text-gray-500">{extraLocked ? extraField.lockedHint : extraField.hint}</p>
              )}
              {formError && <p className="mt-1 text-xs text-red-600">{formError}</p>}
            </div>
          )}

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
            <Button type="submit" loading={saving}>{modal === 'add' ? `Add ${label}` : 'Save Changes'}</Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
