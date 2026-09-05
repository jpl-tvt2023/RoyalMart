import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import Badge from '../../components/ui/Badge';
import Button from '../../components/ui/Button';
import Modal from '../../components/ui/Modal';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import { HistoryButton } from '../../components/shared/HistoryDrawer';
import { formatDateTime } from '../../utils/formatters';
import { STAGES } from '../../utils/stitching';
import {
  listStitchingPrefixes, createStitchingPrefix, updateStitchingPrefix, deleteStitchingPrefix,
} from '../../api/stitchingPrefixes.api';

const inputCls = 'w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f]';
const thCls = 'px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide';

const EMPTY_FORM = { prefix: '', stage: 'Gray' };

/**
 * The incoming-number prefix master.
 *
 * Forked from MasterTab rather than reusing it, for the same reason
 * OutboundProductsTab is: the row is not just a name — the stage column is what
 * gives the prefix its meaning, so it has to be edited alongside the code.
 */
export default function StitchingPrefixesTab() {
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
      setRows(await listStitchingPrefixes());
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not load prefixes');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openAdd = () => { setForm(EMPTY_FORM); setFormError(''); setModal('add'); };
  const openEdit = (row) => {
    setForm({ prefix: row.prefix, stage: row.stage });
    setFormError('');
    setModal({ type: 'edit', row });
  };

  const handleSave = async (e) => {
    e.preventDefault();
    const prefix = form.prefix.trim();
    if (!prefix) { setFormError('Prefix is required'); return; }
    setSaving(true);
    setFormError('');
    try {
      if (modal === 'add') {
        await createStitchingPrefix({ prefix, stage: form.stage });
        toast.success('Prefix added');
      } else {
        await updateStitchingPrefix(modal.row.id, { prefix, stage: form.stage });
        toast.success('Prefix updated');
      }
      setModal(null);
      load();
    } catch (err) {
      const message = err.response?.data?.message || 'Save failed';
      // 409 (duplicate) and the in-use stage guard are both about a specific
      // field, so they read better inline than as a toast that scrolls away.
      if (err.response?.status === 409 || /stage/i.test(message)) setFormError(message);
      else toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await deleteStitchingPrefix(confirmDelete.id);
      toast.success('Prefix deactivated');
      setConfirmDelete(null);
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Delete failed');
    } finally {
      setDeleting(false);
    }
  };

  const editingInUse = modal && modal !== 'add' && modal.row.in_use > 0;

  return (
    <>
      <div className="flex justify-between items-center mb-3">
        <p className="text-sm text-gray-500">
          Each prefix records the stage a lot was received at, which is what puts it on a Stitching tab.
          Several prefixes may point at the same stage.
        </p>
        <Button size="sm" onClick={openAdd}><Plus size={15} />Add Prefix</Button>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className={thCls}>Prefix</th>
                <th className={thCls}>Stage</th>
                <th className={thCls}>In Use</th>
                <th className={thCls}>Status</th>
                <th className={thCls}>Last Updated</th>
                <th className={thCls}>Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading && [...Array(4)].map((_, i) => (
                <tr key={`sk-${i}`}>
                  {[...Array(6)].map((__, j) => (
                    <td key={j} className="px-4 py-3"><div className="h-4 bg-gray-100 rounded animate-pulse" /></td>
                  ))}
                </tr>
              ))}

              {!loading && rows.map(row => (
                <tr key={row.id} className={row.is_active ? '' : 'opacity-50'}>
                  <td className="px-4 py-2 font-mono font-semibold text-[#003049]">{row.prefix}</td>
                  <td className="px-4 py-2">{row.stage}</td>
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
                      <HistoryButton entityType="stitching_prefix" entityId={row.id} title={`${row.prefix} history`} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!loading && rows.length === 0 && (
          <p className="text-center text-gray-400 py-8">No prefixes yet.</p>
        )}
      </div>

      <Modal
        isOpen={!!modal}
        onClose={() => setModal(null)}
        title={modal === 'add' ? 'Add Prefix' : 'Edit Prefix'}
      >
        <form onSubmit={handleSave} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Prefix <span className="text-red-500">*</span>
            </label>
            <input
              value={form.prefix}
              onChange={e => setForm(f => ({ ...f, prefix: e.target.value }))}
              className={inputCls}
              maxLength={20}
              required
              autoFocus
            />
            <p className="mt-1 text-[11px] text-gray-400">
              Printed in front of the incoming number, e.g. GRY0077.
            </p>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Stage <span className="text-red-500">*</span>
            </label>
            <select
              value={form.stage}
              onChange={e => setForm(f => ({ ...f, stage: e.target.value }))}
              className={inputCls}
              disabled={editingInUse}
            >
              {STAGES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            {editingInUse && (
              <p className="mt-1 text-[11px] text-amber-600">
                {modal.row.in_use} lot(s) were received under this prefix, so its stage is locked.
                Deactivate it and add a new prefix for the other stage instead.
              </p>
            )}
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
        title="Deactivate this prefix?"
        message={confirmDelete
          ? `"${confirmDelete.prefix}" will stop being offered for new receipts. The ${confirmDelete.in_use || 0} lot(s) already using it keep it.`
          : ''}
      />
    </>
  );
}
