import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Save, ArrowLeft } from 'lucide-react';
import toast from 'react-hot-toast';
import AppShell from '../../components/layout/AppShell';
import Button from '../../components/ui/Button';
import SummaryEditor from './SummaryEditor';
import { getPO, updatePO } from '../../api/marketplacePO.api';

export default function PurchaseOrderDetail() {
  const { poId } = useParams();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(null);

  useEffect(() => {
    getPO(poId)
      .then(po => setForm({
        vendor: po.vendor,
        vendor_po_id: po.vendor_po_id || '',
        po_date: po.po_date || '',
        expected_delivery_date: po.expected_delivery_date || '',
        po_expiry_date: po.po_expiry_date || '',
        lines: (po.lines || []).map(l => ({ ...l })),
      }))
      .catch(() => toast.error('Failed to load PO'))
      .finally(() => setLoading(false));
  }, [poId]);

  const handleSave = async () => {
    if (!form.vendor_po_id) return toast.error('Vendor PO No. is required');
    if (!form.lines?.length) return toast.error('At least one line item is required');
    setSaving(true);
    try {
      await updatePO(poId, form);
      toast.success('Saved');
      navigate('/purchase-orders');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Save failed');
    } finally { setSaving(false); }
  };

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
      {!loading && form && <SummaryEditor value={form} onChange={setForm} showVendor readOnlyVendor />}
    </AppShell>
  );
}
