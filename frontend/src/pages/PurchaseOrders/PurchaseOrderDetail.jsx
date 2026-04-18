import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Save, ArrowLeft } from 'lucide-react';
import toast from 'react-hot-toast';
import AppShell from '../../components/layout/AppShell';
import Button from '../../components/ui/Button';
import SummaryEditor from './SummaryEditor';
import { getPO, updatePO } from '../../api/marketplacePO.api';
import { getUsers } from '../../api/users.api';
import { useAuth } from '../../context/AuthContext';

export default function PurchaseOrderDetail() {
  const { poId } = useParams();
  const navigate = useNavigate();
  const { user: me } = useAuth();
  const canReassign = me && ['Admin', 'Owner'].includes(me.role);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(null);
  const [poExecutives, setPoExecutives] = useState([]);

  useEffect(() => {
    getPO(poId)
      .then(po => setForm({
        vendor: po.vendor,
        vendor_po_id: po.vendor_po_id || '',
        po_date: po.po_date || '',
        expected_delivery_date: po.expected_delivery_date || '',
        po_expiry_date: po.po_expiry_date || '',
        city: po.city || '',
        onboarded_by: po.onboarded_by || null,
        onboarded_by_name: po.onboarded_by_name || '',
        lines: (po.lines || []).map(l => ({ ...l })),
      }))
      .catch(() => toast.error('Failed to load PO'))
      .finally(() => setLoading(false));
  }, [poId]);

  useEffect(() => {
    if (!canReassign) return;
    getUsers()
      .then(r => setPoExecutives(r.data.filter(u => u.role === 'PO_Executive')))
      .catch(() => {});
  }, [canReassign]);

  const handleSave = async () => {
    if (!form.vendor_po_id) return toast.error('Vendor PO No. is required');
    if (!form.city) return toast.error('City is required');
    if (!form.lines?.length) return toast.error('At least one line item is required');
    setSaving(true);
    try {
      const payload = { ...form };
      if (!canReassign) delete payload.onboarded_by;
      await updatePO(poId, payload);
      toast.success('Saved');
      navigate('/purchase-orders');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Save failed');
    } finally { setSaving(false); }
  };

  const onboarderSlot = form && (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1">Onboarded By</label>
      {canReassign ? (
        <select
          value={form.onboarded_by || ''}
          onChange={e => setForm(f => ({ ...f, onboarded_by: e.target.value ? Number(e.target.value) : null }))}
          className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f]"
        >
          <option value="">Unassigned</option>
          {form.onboarded_by && !poExecutives.some(u => u.id === form.onboarded_by) && (
            <option value={form.onboarded_by}>{form.onboarded_by_name || `User #${form.onboarded_by}`}</option>
          )}
          {poExecutives.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
      ) : (
        <input disabled value={form.onboarded_by_name || '—'} className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-gray-50 text-gray-600" />
      )}
    </div>
  );

  return (
    <AppShell>
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Button variant="ghost" onClick={() => navigate('/purchase-orders')}><ArrowLeft size={16} />Back</Button>
          <div>
            <h1 className="text-2xl font-bold text-[#003049]">Purchase Order {poId}</h1>
            <p className="text-gray-500 text-sm">{form?.vendor} · {form?.vendor_po_id}</p>
          </div>
        </div>
        {form && <Button onClick={handleSave} loading={saving}><Save size={16} />Save Changes</Button>}
      </div>

      {loading && <div className="bg-white rounded-xl border border-gray-200 p-6 animate-pulse h-64" />}
      {!loading && form && (
        <SummaryEditor value={form} onChange={setForm} showVendor readOnlyVendor onboarderSlot={onboarderSlot} />
      )}
    </AppShell>
  );
}
