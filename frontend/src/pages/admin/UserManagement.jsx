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

const ROLES = ['Admin', 'Owner', 'Office_POC', 'Purchase_Team', 'Stocks_Team', 'PO_Executive'];
const roleColors = { Admin: 'red', Owner: 'purple', Office_POC: 'blue', Purchase_Team: 'orange', Stocks_Team: 'green', PO_Executive: 'yellow' };

const EMPTY_FORM = { name: '', email: '', roles: ['Office_POC'], password: '' };

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
  const openEdit = (u) => { setForm({ name: u.name, email: u.email, roles: u.roles || [], password: '' }); setModal({ type: 'edit', id: u.id }); };

  const toggleRole = (role) => {
    setForm(f => {
      const has = f.roles.includes(role);
      return { ...f, roles: has ? f.roles.filter(r => r !== role) : [...f.roles, role] };
    });
  };

  const handleSave = async (e) => {
    e.preventDefault();
    if (!form.roles.length) return toast.error('Select at least one role');
    setSaving(true);
    try {
      if (modal === 'add') {
        await createUser({ name: form.name, email: form.email, password: form.password, roles: form.roles });
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
      await deleteUser(confirmDelete.id);
      toast.success('User deleted');
      setConfirmDelete(null);
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Delete failed');
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
                {['Name', 'Email', 'Roles', 'First Login?', 'Joined', 'Actions'].map(h => (
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
                  <td className="px-4 py-3 text-gray-600">{u.email}</td>
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
              <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
              <input type="email" required value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f]" />
            </div>
          )}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Roles <span className="text-gray-400 font-normal">(pick one or more)</span></label>
            <div className="grid grid-cols-2 gap-2 p-3 border border-gray-200 rounded-lg">
              {ROLES.map(r => (
                <label key={r} className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.roles.includes(r)}
                    onChange={() => toggleRole(r)}
                    className="w-4 h-4 accent-[#c1121f]"
                  />
                  {r}
                </label>
              ))}
            </div>
            {form.roles.length === 0 && (
              <p className="text-xs text-red-500 mt-1">Select at least one role.</p>
            )}
          </div>
          {modal === 'add' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Temporary Password</label>
              <input type="text" required value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f]" placeholder="Min. 8 characters" />
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
        title="Delete User"
        message={`Are you sure you want to delete ${confirmDelete?.name}? This action cannot be undone.`}
        confirmLabel="Delete"
        loading={saving}
      />
    </AppShell>
  );
}
