import { useEffect, useState } from 'react';
import AppShell from '../../components/layout/AppShell';
import Modal from '../../components/ui/Modal';
import Button from '../../components/ui/Button';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import { getTeams, createTeam, updateTeam, deleteTeam, addMember, removeMember } from '../../api/teams.api';
import { ChevronDown, ChevronUp, Users, Plus, Pencil, Trash2, UserPlus } from 'lucide-react';
import toast from 'react-hot-toast';
import { useRBAC } from '../../hooks/useRBAC';

export default function TeamManagement() {
  const { canAccess } = useRBAC();
  const isAdmin = canAccess('Admin');
  const [teams, setTeams] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState({});
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState({ team_name: '', lead_name: '' });
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [newMember, setNewMember] = useState({});

  const load = () => {
    setLoading(true);
    getTeams().then(r => setTeams(r.data)).catch(() => toast.error('Failed to load teams')).finally(() => setLoading(false));
  };
  useEffect(load, []);

  const toggleExpand = (id) => setExpanded(e => ({ ...e, [id]: !e[id] }));

  const openAdd = () => { setForm({ team_name: '', lead_name: '' }); setModal('add'); };
  const openEdit = (t) => { setForm({ team_name: t.team_name, lead_name: t.lead_name || '' }); setModal({ type: 'edit', id: t.id }); };

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      if (modal === 'add') {
        await createTeam(form);
        toast.success('Team created');
      } else {
        await updateTeam(modal.id, form);
        toast.success('Team updated');
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
      await deleteTeam(confirmDelete.id);
      toast.success('Team deleted');
      setConfirmDelete(null);
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Delete failed');
    } finally { setSaving(false); }
  };

  const handleAddMember = async (teamId) => {
    const name = newMember[teamId]?.trim();
    if (!name) return;
    setSaving(true);
    try {
      await addMember(teamId, name);
      setNewMember(n => ({ ...n, [teamId]: '' }));
      toast.success('Member added');
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to add member');
    } finally { setSaving(false); }
  };

  const handleRemoveMember = async (teamId, memberId, memberName) => {
    try {
      await removeMember(teamId, memberId);
      toast.success(`${memberName} removed`);
      load();
    } catch (err) {
      toast.error('Failed to remove member');
    }
  };

  return (
    <AppShell>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-[#003049]">Team Management</h1>
          <p className="text-gray-500 text-sm">{teams.length} warehouse team{teams.length !== 1 ? 's' : ''}</p>
        </div>
        {isAdmin && <Button onClick={openAdd}><Users size={16} />Add Team</Button>}
      </div>

      <div className="space-y-3">
        {loading ? (
          [...Array(3)].map((_, i) => (
            <div key={i} className="bg-white rounded-xl border border-gray-200 h-16 animate-pulse" />
          ))
        ) : teams.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-200 p-8 text-center text-gray-400">No teams yet</div>
        ) : teams.map(team => (
          <div key={team.id} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4">
              <div className="flex items-center gap-3 cursor-pointer flex-1" onClick={() => toggleExpand(team.id)}>
                <div className="w-8 h-8 bg-[#003049] rounded-lg flex items-center justify-center">
                  <Users size={16} className="text-white" />
                </div>
                <div>
                  <p className="font-semibold text-[#003049]">{team.team_name}</p>
                  <p className="text-xs text-gray-400">{team.lead_name ? `Lead: ${team.lead_name}` : 'No lead assigned'} · {team.members?.length || 0} member{team.members?.length !== 1 ? 's' : ''}</p>
                </div>
              </div>
              <div className="flex items-center gap-1">
                {isAdmin && <>
                  <button onClick={() => openEdit(team)} className="p-1.5 rounded hover:bg-blue-50 text-blue-500"><Pencil size={14} /></button>
                  <button onClick={() => setConfirmDelete({ id: team.id, name: team.team_name })} className="p-1.5 rounded hover:bg-red-50 text-red-500"><Trash2 size={14} /></button>
                </>}
                <button onClick={() => toggleExpand(team.id)} className="p-1.5 rounded hover:bg-gray-100 text-gray-500">
                  {expanded[team.id] ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </button>
              </div>
            </div>

            {expanded[team.id] && (
              <div className="border-t border-gray-100 px-5 py-4 bg-gray-50">
                <div className="space-y-2 mb-3">
                  {(team.members || []).length === 0 ? (
                    <p className="text-sm text-gray-400">No members yet</p>
                  ) : team.members.map(m => (
                    <div key={m.id} className="flex items-center justify-between py-1">
                      <span className="text-sm text-gray-700">{m.member_name}</span>
                      {isAdmin && (
                        <button onClick={() => handleRemoveMember(team.id, m.id, m.member_name)} className="p-1 rounded hover:bg-red-50 text-red-400 hover:text-red-600">
                          <Trash2 size={12} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                {isAdmin && (
                  <div className="flex gap-2 mt-3">
                    <input
                      type="text"
                      value={newMember[team.id] || ''}
                      onChange={e => setNewMember(n => ({ ...n, [team.id]: e.target.value }))}
                      onKeyDown={e => e.key === 'Enter' && handleAddMember(team.id)}
                      placeholder="Add member name..."
                      className="flex-1 px-3 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f]"
                    />
                    <Button size="sm" onClick={() => handleAddMember(team.id)} disabled={saving}><Plus size={14} />Add</Button>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      <Modal isOpen={!!modal} onClose={() => setModal(null)} title={modal === 'add' ? 'Add New Team' : 'Edit Team'} size="sm">
        <form onSubmit={handleSave} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Team Name</label>
            <input required value={form.team_name} onChange={e => setForm(f => ({ ...f, team_name: e.target.value }))} className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f]" placeholder="e.g. Team Alpha" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Team Lead Name</label>
            <input value={form.lead_name} onChange={e => setForm(f => ({ ...f, lead_name: e.target.value }))} className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f]" placeholder="Optional" />
          </div>
          <div className="flex gap-3 justify-end pt-2">
            <Button variant="ghost" type="button" onClick={() => setModal(null)}>Cancel</Button>
            <Button type="submit" loading={saving}>{modal === 'add' ? 'Create Team' : 'Save Changes'}</Button>
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        isOpen={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        onConfirm={handleDelete}
        title="Delete Team"
        message={`Delete team "${confirmDelete?.name}"? All members will also be removed.`}
        confirmLabel="Delete Team"
        loading={saving}
      />
    </AppShell>
  );
}
