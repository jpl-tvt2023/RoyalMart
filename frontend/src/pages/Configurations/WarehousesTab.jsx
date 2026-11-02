import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Plus, Pencil, Power } from 'lucide-react';
import Badge from '../../components/ui/Badge';
import Button from '../../components/ui/Button';
import Modal from '../../components/ui/Modal';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import { HistoryButton } from '../../components/shared/HistoryDrawer';
import { formatDateTime } from '../../utils/formatters';
import {
  listWarehouses, createWarehouse, updateWarehouse, deleteWarehouse,
} from '../../api/warehouses.api';

const inputCls = 'w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f]';
const thCls = 'px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide';

const EMPTY_FORM = { name: '', code: '', prefix: '' };

/**
 * The warehouses master (migration 096).
 *
 * Each row is one of our own warehouses: a tab on the Stitching page, a
 * destination on the challan form and a stage option on the receipt form. A lot
 * is never stamped with its warehouse -- it points at the incoming prefix it was
 * numbered under, and each Warehouse prefix belongs to one warehouse -- so a
 * rename here shows on every lot at once.
 *
 * Adding a warehouse asks for its first prefix in the same form, because a
 * warehouse with none could not take a single lot. More prefixes, and renaming
 * that one, live on the Stitching Prefixes tab like every other stage's.
 */
export default function WarehousesTab() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null); // 'add' | { type: 'edit', row }
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmDeactivate, setConfirmDeactivate] = useState(null);
  const [toggling, setToggling] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await listWarehouses());
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not load warehouses');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openAdd = () => { setForm(EMPTY_FORM); setFormError(''); setModal('add'); };
  const openEdit = (row) => {
    setForm({ name: row.name, code: row.code, prefix: '' });
    setFormError('');
    setModal({ type: 'edit', row });
  };

  const handleSave = async (e) => {
    e.preventDefault();
    const name = form.name.trim();
    const code = form.code.trim();
    const prefix = form.prefix.trim();
    if (!name) { setFormError('Warehouse name is required'); return; }
    if (!code) { setFormError('Code is required'); return; }
    if (modal === 'add' && !prefix) { setFormError('Incoming prefix is required'); return; }
    setSaving(true);
    setFormError('');
    try {
      if (modal === 'add') {
        await createWarehouse({ name, code, prefix });
        toast.success(`${name} added`);
      } else {
        await updateWarehouse(modal.row.id, { name, code });
        toast.success('Warehouse updated');
      }
      setModal(null);
      load();
    } catch (err) {
      const message = err.response?.data?.message || 'Save failed';
      // A duplicate name, code or prefix is about a specific field, so it reads
      // better inline than as a toast that scrolls away.
      if (err.response?.status === 409 || err.response?.status === 400) setFormError(message);
      else toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const setActive = async (row, active) => {
    setToggling(true);
    try {
      if (active) await updateWarehouse(row.id, { is_active: true });
      else await deleteWarehouse(row.id);
      toast.success(active ? `${row.name} reactivated` : `${row.name} deactivated`);
      setConfirmDeactivate(null);
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Update failed');
    } finally {
      setToggling(false);
    }
  };

  return (
    <>
      <div className="flex justify-between items-center mb-3">
        <p className="text-sm text-gray-500">
          Each warehouse gets its own tab on the Stitching page, and is offered wherever goods can be sent or received.
        </p>
        <Button size="sm" onClick={openAdd}><Plus size={15} />Add Warehouse</Button>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className={thCls}>Name</th>
                <th className={thCls}>Code</th>
                <th className={thCls}>Prefixes</th>
                <th className={thCls}>Lots</th>
                <th className={thCls}>Status</th>
                <th className={thCls}>Last Updated</th>
                <th className={thCls}>Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading && [...Array(2)].map((_, i) => (
                <tr key={`sk-${i}`}>
                  {[...Array(7)].map((__, j) => (
                    <td key={j} className="px-4 py-3"><div className="h-4 bg-gray-100 rounded animate-pulse" /></td>
                  ))}
                </tr>
              ))}

              {!loading && rows.map(row => (
                <tr key={row.id} className={row.is_active ? '' : 'opacity-50'}>
                  <td className="px-4 py-2 font-medium text-[#003049]">{row.name}</td>
                  <td className="px-4 py-2 font-mono text-gray-700">{row.code}</td>
                  <td className="px-4 py-2 font-mono text-gray-600">{row.prefixes || '—'}</td>
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
                      <button
                        type="button"
                        onClick={() => (row.is_active ? setConfirmDeactivate(row) : setActive(row, true))}
                        disabled={toggling}
                        title={row.is_active ? 'Deactivate' : 'Reactivate'}
                        className={`p-1.5 rounded disabled:opacity-40 ${row.is_active ? 'hover:bg-red-50 text-red-500' : 'hover:bg-green-50 text-green-600'}`}
                      >
                        <Power size={14} />
                      </button>
                      <HistoryButton entityType="warehouse" entityId={row.id} title={`${row.name} history`} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!loading && rows.length === 0 && (
          <p className="text-center text-gray-400 py-8">No warehouses yet.</p>
        )}
      </div>

      <Modal
        isOpen={!!modal}
        onClose={() => setModal(null)}
        title={modal === 'add' ? 'Add Warehouse' : 'Edit Warehouse'}
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
            <p className="mt-1 text-[11px] text-gray-400">
              What the Stitching tab and every lot in it are labelled, e.g. Panchal.
            </p>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Code <span className="text-red-500">*</span>
            </label>
            <input
              value={form.code}
              onChange={e => setForm(f => ({ ...f, code: e.target.value }))}
              className={inputCls}
              maxLength={10}
              required
            />
            <p className="mt-1 text-[11px] text-gray-400">
              Names the warehouse&apos;s own incoming number on a challan, e.g. PCL → &quot;PCL Inc No&quot;.
            </p>
          </div>

          {modal === 'add' ? (
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                Incoming Prefix <span className="text-red-500">*</span>
              </label>
              <input
                value={form.prefix}
                onChange={e => setForm(f => ({ ...f, prefix: e.target.value }))}
                className={inputCls}
                maxLength={20}
                required
              />
              <p className="mt-1 text-[11px] text-gray-400">
                Printed in front of the incoming number of every lot here, e.g. PNL0077. Must not be used by any other stage.
              </p>
            </div>
          ) : (
            <p className="text-[11px] text-gray-500">
              Numbered under <span className="font-mono">{modal?.row?.prefixes || '—'}</span>.
              Prefixes are added or renamed on the Stitching Prefixes tab.
            </p>
          )}

          {formError && <p className="text-xs text-red-600">{formError}</p>}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setModal(null)}>Cancel</Button>
            <Button type="submit" loading={saving}>Save</Button>
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        isOpen={!!confirmDeactivate}
        onClose={() => setConfirmDeactivate(null)}
        onConfirm={() => setActive(confirmDeactivate, false)}
        loading={toggling}
        confirmLabel="Deactivate"
        title="Deactivate this warehouse?"
        message={confirmDeactivate
          ? `${confirmDeactivate.name} will stop being offered for new challans and receipts. `
            + `The ${confirmDeactivate.in_use || 0} lot(s) already there stay, and its tab stays while it holds any.`
          : ''}
      />
    </>
  );
}
