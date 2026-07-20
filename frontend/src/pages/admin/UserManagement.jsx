import { useEffect, useState } from 'react';
import AppShell from '../../components/layout/AppShell';
import Modal from '../../components/ui/Modal';
import Button from '../../components/ui/Button';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import Badge from '../../components/ui/Badge';
import { getUsers, createUser, updateUser, deleteUser, resetUserPassword } from '../../api/users.api';
import { formatDate } from '../../utils/formatters';
import { UserPlus, Pencil, Trash2, KeyRound } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuth } from '../../context/AuthContext';
import { ROLES, BASE_ROLES, TAG_ROLES } from '../../utils/roles';
import { HistoryButton } from '../../components/shared/HistoryDrawer';
import PasswordCriteria from '../../components/shared/PasswordCriteria';

const roleColors = { Admin: 'red', Owner: 'purple', Employee: 'blue', Office_POC: 'orange', Warehouse_POC: 'green', Purchase_Head: 'navy' };

const EMPTY_FORM = { name: '', username: '', roles: [ROLES.EMPLOYEE], password: '' };

export default function UserManagement() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [resetModal, setResetModal] = useState(null);
  const [resetPwd, setResetPwd] = useState('');

  const load = () => {
    setLoading(true);
    getUsers().then(r => setUsers(r.data)).catch(() => toast.error('Failed to load users')).finally(() => setLoading(false));
  };
  useEffect(load, []);

  const openAdd = () => { setForm(EMPTY_FORM); setModal('add'); };
  const openEdit = (u) => { setForm({ name: u.name, username: u.username, roles: u.roles || [], password: '' }); setModal({ type: 'edit', id: u.id }); };

  // Roles = one base access role (Admin/Owner/Employee) + optional POC tags.
  const baseRole = form.roles.find(r => BASE_ROLES.includes(r)) || '';
  const setBaseRole = (role) => {
    setForm(f => ({ ...f, roles: [role, ...f.roles.filter(r => TAG_ROLES.includes(r))] }));
  };
  const toggleTag = (role) => {
    setForm(f => {
      const has = f.roles.includes(role);
      return { ...f, roles: has ? f.roles.filter(r => r !== role) : [...f.roles, role] };
    });
  };

  const handleSave = async (e) => {
    e.preventDefault();
    if (!baseRole) return toast.error('Select a base role (Admin, Owner or Employee)');
    setSaving(true);
    try {
      if (modal === 'add') {
        await createUser({ name: form.name, username: form.username, password: form.password, roles: form.roles });
        toast.success('User created');
      } else {
        await updateUser(modal.id, { name: form.name, roles: form.roles });
        toast.success('User updated');
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
      await deleteUser(confirmDelete.id, { force: confirmDelete.force });
      toast.success('User deleted');
      setConfirmDelete(null);
      load();
    } catch (err) {
      const data = err.response?.data;
      // User is a POC on some POs — switch the dialog to a force-unassign confirmation.
      if (data?.requiresPocUnassign) {
        setConfirmDelete(c => ({ ...c, force: true, message: data.message }));
      } else {
        toast.error(data?.message || 'Delete failed');
        setConfirmDelete(null);
      }
    } finally { setSaving(false); }
  };

  const handleReset = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await resetUserPassword(resetModal.id, resetPwd);
      toast.success('Password reset. User will be prompted to change on next login.');
      setResetModal(null);
      setResetPwd('');
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Reset failed');
    } finally { setSaving(false); }
  };

  return (
    <AppShell>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-[#003049]">User Management</h1>
          <p className="text-gray-500 text-sm">{users.length} user{users.length !== 1 ? 's' : ''}</p>
        </div>
        <Button onClick={openAdd}><UserPlus size={16} />Add User</Button>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                {['Name', 'User ID', 'Roles', 'First Login?', 'Joined', 'Actions'].map(h => (
                  <th key={h} className="px-4 py-3 text-left font-semibold text-gray-600 whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                [...Array(4)].map((_, i) => (
                  <tr key={i}><td colSpan={6} className="px-4 py-3"><div className="h-4 bg-gray-100 rounded animate-pulse" /></td></tr>
                ))
              ) : users.map(u => (
                <tr key={u.id} className="border-b border-gray-100 hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3 font-medium text-gray-900">{u.name}</td>
                  <td className="px-4 py-3 text-gray-600">{u.username}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {(u.roles || []).map(r => (
                        <Badge key={r} color={roleColors[r] || 'gray'}>{r}</Badge>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {u.is_first_login
                      ? <span className="text-amber-600 text-xs font-semibold">Pending Reset</span>
                      : <span className="text-green-600 text-xs">Active</span>}
                  </td>
                  <td className="px-4 py-3 text-gray-500">{formatDate(u.created_at)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
                      <button onClick={() => openEdit(u)} title="Edit" className="p-1.5 rounded hover:bg-blue-50 text-blue-500 transition-colors"><Pencil size={14} /></button>
                      <button onClick={() => setResetModal({ id: u.id, name: u.name })} title="Reset Password" className="p-1.5 rounded hover:bg-amber-50 text-amber-500 transition-colors"><KeyRound size={14} /></button>
                      <HistoryButton entityType="user" entityId={u.id} title={`History — ${u.name}`} />
                      {u.id !== me?.id && (
                        <button onClick={() => setConfirmDelete({ id: u.id, name: u.name })} title="Delete" className="p-1.5 rounded hover:bg-red-50 text-red-500 transition-colors"><Trash2 size={14} /></button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && users.length === 0 && (
            <p className="text-center text-gray-400 py-8">No users found</p>
          )}
        </div>
      </div>

      <Modal isOpen={!!modal} onClose={() => setModal(null)} title={modal === 'add' ? 'Add New User' : 'Edit User'}>
        <form onSubmit={handleSave} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Full Name</label>
            <input required value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f]" />
          </div>
          {modal === 'add' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">User ID</label>
              <input type="text" required autoCapitalize="none" autoCorrect="off" value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value.toLowerCase() }))} className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f]" placeholder="e.g. mukesh" />
              <p className="text-xs text-gray-400 mt-1">Lowercase letters, numbers, dot, underscore or hyphen (3-30 chars). This is what the user logs in with.</p>
            </div>
          )}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Access Role <span className="text-gray-400 font-normal">(pick one)</span></label>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 p-3 border border-gray-200 rounded-lg">
              {BASE_ROLES.map(r => (
                <label key={r} className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                  <input
                    type="radio"
                    name="baseRole"
                    checked={baseRole === r}
                    onChange={() => setBaseRole(r)}
                    className="w-4 h-4 accent-[#c1121f]"
                  />
                  {r}
                </label>
              ))}
            </div>
            <p className="text-xs text-gray-400 mt-1">Admin / Owner can access everything. Employee can access everything except the Admin section.</p>
            {!baseRole && (
              <p className="text-xs text-red-500 mt-1">Select a base access role.</p>
            )}
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Tags <span className="text-gray-400 font-normal">(optional)</span></label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 p-3 border border-gray-200 rounded-lg">
              {TAG_ROLES.map(r => (
                <label key={r} className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.roles.includes(r)}
                    onChange={() => toggleTag(r)}
                    className="w-4 h-4 accent-[#c1121f]"
                  />
                  {r}
                </label>
              ))}
            </div>
            <p className="text-xs text-gray-400 mt-1">Allows the user to be assigned as an Office / Warehouse POC on orders, or picked as Approved By on outbound POs.</p>
          </div>
          {modal === 'add' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Temporary Password</label>
              <input type="text" required value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f]" placeholder="Min. 8 characters" />
              <PasswordCriteria password={form.password} />
              <p className="text-xs text-gray-400 mt-1">User will be forced to change this on first login</p>
            </div>
          )}
          <div className="flex gap-3 justify-end pt-2">
            <Button variant="ghost" type="button" onClick={() => setModal(null)}>Cancel</Button>
            <Button type="submit" loading={saving}>{modal === 'add' ? 'Create User' : 'Save Changes'}</Button>
          </div>
        </form>
      </Modal>

      <Modal isOpen={!!resetModal} onClose={() => { setResetModal(null); setResetPwd(''); }} title={`Reset Password — ${resetModal?.name}`} size="sm">
        <form onSubmit={handleReset} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">New Temporary Password</label>
            <input type="text" required value={resetPwd} onChange={e => setResetPwd(e.target.value)} className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f]" placeholder="Min. 8 characters" />
            <PasswordCriteria password={resetPwd} />
            <p className="text-xs text-gray-400 mt-1">User will be forced to change this on next login</p>
          </div>
          <div className="flex gap-3 justify-end">
            <Button variant="ghost" type="button" onClick={() => { setResetModal(null); setResetPwd(''); }}>Cancel</Button>
            <Button variant="secondary" type="submit" loading={saving}>Reset Password</Button>
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        isOpen={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        onConfirm={handleDelete}
        title={confirmDelete?.force ? 'Unassign & Delete User' : 'Delete User'}
        message={confirmDelete?.message
          || `Are you sure you want to delete ${confirmDelete?.name}? This action cannot be undone.`}
        confirmLabel={confirmDelete?.force ? 'Unassign & Delete' : 'Delete'}
        loading={saving}
      />
    </AppShell>
  );
}
