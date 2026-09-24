import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import Badge from '../../components/ui/Badge';
import Button from '../../components/ui/Button';
import Modal from '../../components/ui/Modal';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import { HistoryButton } from '../../components/shared/HistoryDrawer';
import { formatDateTime } from '../../utils/formatters';
import { PARTY_USE_STAGES } from '../../utils/stitching';
import {
  listStitchingParties, createStitchingParty, updateStitchingParty, deleteStitchingParty,
} from '../../api/stitchingParties.api';

const inputCls = 'w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f]';
const thCls = 'px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide';

const EMPTY_FORM = { name: '', short_name: '', uses: [] };

// Twin of SHORT_NAME_MAX in stitchingParties.controller.js.
const SHORT_NAME_MAX = 10;

/**
 * The stitching party master: processing houses, and the buyers finished goods
 * are sold to.
 *
 * Forked from MasterTab for the same reason StitchingPrefixesTab is: the row is
 * not just a name. What a party is ALLOWED TO DO is the point of the record —
 * the challan form offers only parties tagged for the destination being sent to,
 * so an untagged party is invisible there no matter how active it is.
 *
 * That is why the "Valid for" column shows "Not tagged yet" rather than a blank:
 * migration 079 imported every name already typed into a challan without tags,
 * and those rows need someone to come and tick them.
 */
export default function StitchingPartiesTab() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null); // 'add' | { type: 'edit', row }
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await listStitchingParties());
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not load parties');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openAdd = () => { setForm(EMPTY_FORM); setFormError(''); setModal('add'); };
  const openEdit = (row) => {
    // Only tags that are still destinations. A party tagged for Processed before
    // migration 087 carries a Processing tag, and nothing is sent TO Processing
    // any more -- re-sending it would get the whole save refused.
    setForm({
      name: row.name,
      short_name: row.short_name || '',
      uses: (row.uses || []).filter(u => PARTY_USE_STAGES.includes(u)),
    });
    setFormError('');
    setModal({ type: 'edit', row });
  };

  const toggleUse = (use) => setForm(f => ({
    ...f,
    uses: f.uses.includes(use) ? f.uses.filter(u => u !== use) : [...f.uses, use],
  }));

  const handleSave = async (e) => {
    e.preventDefault();
    const name = form.name.trim();
    if (!name) { setFormError('Name is required'); return; }
    setSaving(true);
    setFormError('');
    try {
      const body = { name, short_name: form.short_name.trim(), uses: form.uses };
      if (modal === 'add') {
        await createStitchingParty(body);
        toast.success('Party added');
      } else {
        await updateStitchingParty(modal.row.id, body);
        toast.success('Party updated');
      }
      setModal(null);
      load();
    } catch (err) {
      const message = err.response?.data?.message || 'Save failed';
      // A duplicate name is about a specific field, so it reads better inline
      // than as a toast that scrolls away. Same call as the prefixes tab.
      if (err.response?.status === 409) setFormError(message);
      else toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await deleteStitchingParty(confirmDelete.id);
      toast.success('Party deactivated');
      setConfirmDelete(null);
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Delete failed');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <div className="flex justify-between items-center mb-3">
        <p className="text-sm text-gray-500">
          Who material is sent to. Each party is ticked for the jobs it may take, and the
          challan form offers only parties tagged for where the goods are going.
        </p>
        <Button size="sm" onClick={openAdd}><Plus size={15} />Add Party</Button>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className={thCls}>Name</th>
                <th className={thCls}>Short Name</th>
                <th className={thCls}>Valid For</th>
                <th className={thCls}>In Use</th>
                <th className={thCls}>Status</th>
                <th className={thCls}>Last Updated</th>
                <th className={thCls}>Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading && [...Array(4)].map((_, i) => (
                <tr key={`sk-${i}`}>
                  {[...Array(7)].map((__, j) => (
                    <td key={j} className="px-4 py-3"><div className="h-4 bg-gray-100 rounded animate-pulse" /></td>
                  ))}
                </tr>
              ))}

              {!loading && rows.map(row => (
                <tr key={row.id} className={row.is_active ? '' : 'opacity-50'}>
                  <td className="px-4 py-2 font-medium text-[#003049]">{row.name}</td>
                  <td className="px-4 py-2 font-mono text-gray-600">
                    {row.short_name || <span className="text-gray-300 font-sans">initials</span>}
                  </td>
                  <td className="px-4 py-2">
                    {row.uses?.length ? (
                      <div className="flex flex-wrap gap-1">
                        {row.uses.map(u => <Badge key={u} color="blue">{u}</Badge>)}
                      </div>
                    ) : (
                      // Not a blank cell: an untagged party is offered nowhere,
                      // which is a thing someone has to come and fix.
                      <span className="text-amber-600 text-xs">Not tagged yet</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-gray-600">{row.in_use || 0}</td>
                  <td className="px-4 py-2">
                    <Badge color={row.is_active ? 'green' : 'gray'}>{row.is_active ? 'Active' : 'Inactive'}</Badge>
                  </td>
                  <td className="px-4 py-2">
                    <div className="text-gray-600">{row.updated_by_name || '—'}</div>
                    <div className="text-[11px] text-gray-400">{formatDateTime(row.updated_at)}</div>
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-1">
                      <button type="button" onClick={() => openEdit(row)} title="Edit" className="p-1.5 rounded hover:bg-gray-100 text-gray-500">
                        <Pencil size={14} />
                      </button>
                      {!!row.is_active && (
                        <button type="button" onClick={() => setConfirmDelete(row)} title="Deactivate" className="p-1.5 rounded hover:bg-red-50 text-red-500">
                          <Trash2 size={14} />
                        </button>
                      )}
                      <HistoryButton entityType="stitching_party" entityId={row.id} title={`${row.name} history`} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!loading && rows.length === 0 && (
          <p className="text-center text-gray-400 py-8">No parties yet.</p>
        )}
      </div>

      <Modal
        isOpen={!!modal}
        onClose={() => setModal(null)}
        title={modal === 'add' ? 'Add Party' : 'Edit Party'}
      >
        <form onSubmit={handleSave} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Name <span className="text-red-500">*</span>
            </label>
            <input
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              className={inputCls}
              maxLength={50}
              required
              autoFocus
            />
            {/* Renaming is safe while in use: a challan stores the spelling it
                was raised under, so past dispatches do not change under anyone. */}
            <p className="mt-1 text-[11px] text-gray-400">
              Challans already raised keep the name they were raised under.
            </p>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Short Name</label>
            <input
              value={form.short_name}
              onChange={e => setForm(f => ({ ...f, short_name: e.target.value }))}
              className={inputCls}
              maxLength={SHORT_NAME_MAX}
              placeholder="e.g. SKT"
            />
            {/* The Stitching page lists each job worker a lot passed through as
                "Stitching - SKT", under the PO party it started from. */}
            <p className="mt-1 text-[11px] text-gray-400">
              Shown on the Stitching page as “Stitching - {form.short_name.trim() || 'initials'}”.
              Leave blank to use the name&apos;s initials.
            </p>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Valid For</label>
            <div className="grid grid-cols-2 gap-2">
              {PARTY_USE_STAGES.map(use => (
                <label key={use} className="flex items-center gap-2 text-sm text-gray-700">
                  <input
                    type="checkbox"
                    checked={form.uses.includes(use)}
                    onChange={() => toggleUse(use)}
                    className="rounded border-gray-300 text-[#c1121f] focus:ring-[#c1121f]/30"
                  />
                  {use}
                </label>
              ))}
            </div>
            <p className="mt-1 text-[11px] text-gray-400">
              {form.uses.length
                ? 'Offered on a challan only when the goods are going to one of these.'
                : 'With nothing ticked this party is never offered on a challan.'}
            </p>
          </div>

          {formError && <p className="text-xs text-red-600">{formError}</p>}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setModal(null)}>Cancel</Button>
            <Button type="submit" loading={saving}>Save</Button>
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        isOpen={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        onConfirm={handleDelete}
        loading={deleting}
        confirmLabel="Deactivate"
        title="Deactivate this party?"
        message={confirmDelete
          ? `"${confirmDelete.name}" will stop being offered on new challans. The ${confirmDelete.in_use || 0} challan(s) already naming it keep it.`
          : ''}
      />
    </>
  );
}
