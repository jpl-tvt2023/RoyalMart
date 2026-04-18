import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Upload, Check, X } from 'lucide-react';
import toast from 'react-hot-toast';
import AppShell from '../../components/layout/AppShell';
import Button from '../../components/ui/Button';
import SummaryEditor from './SummaryEditor';
import { parsePreview, commitPO } from '../../api/marketplacePO.api';

const VENDORS = ['Swiggy', 'Zepto', 'Blinkit'];

export default function PurchaseOrderImport() {
  const navigate = useNavigate();
  const [vendor, setVendor] = useState('');
  const [file, setFile] = useState(null);
  const [parsing, setParsing] = useState(false);
  const [summary, setSummary] = useState(null);
  const [committing, setCommitting] = useState(false);

  const handleParse = async (e) => {
    e.preventDefault();
    if (!vendor) return toast.error('Select a vendor');
    if (!file) return toast.error('Choose a PDF file');
    setParsing(true);
    try {
      const data = await parsePreview(file, vendor);
      setSummary({
        vendor: data.vendor,
        vendor_po_id: data.vendor_po_id || '',
        po_date: data.po_date || '',
        expected_delivery_date: data.expected_delivery_date || '',
        po_expiry_date: data.po_expiry_date || '',
        lines: data.lines || [],
      });
      toast.success(`Parsed ${data.lines.length} line item${data.lines.length !== 1 ? 's' : ''}`);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Parse failed');
    } finally { setParsing(false); }
  };

  const handleApprove = async () => {
    if (!summary.vendor_po_id) return toast.error('Vendor PO No. is required');
    if (!summary.lines?.length) return toast.error('At least one line item is required');
    setCommitting(true);
    try {
      const res = await commitPO(summary);
      toast.success(`Saved as ${res.po_id}`);
      navigate('/purchase-orders');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Save failed');
    } finally { setCommitting(false); }
  };

  const handleReject = () => {
    setSummary(null);
    setFile(null);
  };

  return (
    <AppShell>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-[#003049]">Import Purchase Order</h1>
        <p className="text-gray-500 text-sm">Upload a marketplace PO PDF, review, then approve to save.</p>
      </div>

      {!summary && (
        <form onSubmit={handleParse} className="bg-white rounded-xl border border-gray-200 p-6 space-y-4 max-w-2xl">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Vendor</label>
            <select required value={vendor} onChange={e => setVendor(e.target.value)} className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30">
              <option value="">Select vendor...</option>
              {VENDORS.map(v => <option key={v} value={v}>{v}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">PO PDF</label>
            <input required type="file" accept="application/pdf,.pdf" onChange={e => setFile(e.target.files?.[0] || null)} className="w-full text-sm file:mr-3 file:px-3 file:py-2 file:rounded-lg file:border-0 file:bg-[#003049] file:text-white file:cursor-pointer" />
            <p className="text-xs text-gray-400 mt-1">Max 10 MB. PDF files only.</p>
          </div>
          <div className="flex gap-3 justify-end">
            <Button type="button" variant="ghost" onClick={() => navigate('/purchase-orders')}>Cancel</Button>
            <Button type="submit" loading={parsing}><Upload size={16} />Parse PDF</Button>
          </div>
        </form>
      )}

      {summary && (
        <div className="space-y-5">
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm text-blue-900">
            Review the parsed data below. Edit any field inline before approving. Rejecting discards this upload.
          </div>
          <SummaryEditor value={summary} onChange={setSummary} showVendor readOnlyVendor />
          <div className="flex gap-3 justify-end">
            <Button variant="ghost" onClick={handleReject}><X size={16} />Reject</Button>
            <Button onClick={handleApprove} loading={committing}><Check size={16} />Approve &amp; Save</Button>
          </div>
        </div>
      )}
    </AppShell>
  );
}
