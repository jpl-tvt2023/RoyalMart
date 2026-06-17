import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Upload, Check, X, Pencil } from 'lucide-react';
import toast from 'react-hot-toast';
import AppShell from '../../components/layout/AppShell';
import Button from '../../components/ui/Button';
import Modal from '../../components/ui/Modal';
import SummaryEditor from './SummaryEditor';
import { parsePreview, commitPO } from '../../api/marketplacePO.api';
import { listVendors } from '../../api/vendors.api';

export default function PurchaseOrderImport() {
  const navigate = useNavigate();
  const [vendor, setVendor] = useState('');
  const [file, setFile] = useState(null);
  const [parsing, setParsing] = useState(false);
  const [summary, setSummary] = useState(null);
  const [mode, setMode] = useState(null); // 'pdf' | 'manual'
  const [committing, setCommitting] = useState(false);
  const [vendors, setVendors] = useState([]);
  const [parserMissing, setParserMissing] = useState(null);

  useEffect(() => {
    listVendors()
      .then(rows => setVendors(rows.filter(v => v.is_active)))
      .catch(() => {});
  }, []);

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
        po_expiry_date: data.po_expiry_date || '',
        city: data.city || '',
        status: 'Open',
        party_name: data.party_name || '',
        lines: data.lines || [],
      });
      setMode('pdf');
      toast.success(`Parsed ${data.lines.length} line item${data.lines.length !== 1 ? 's' : ''}`);
    } catch (err) {
      const data = err.response?.data;
      if (data?.error === 'vendor_parser_not_implemented') {
        setParserMissing({ vendor: data.vendor || vendor, message: data.message });
      } else {
        toast.error(data?.message || 'Parse failed');
      }
    } finally { setParsing(false); }
  };

  const handleAddManually = () => {
    if (!vendor) return toast.error('Select a vendor');
    setSummary({
      vendor,
      vendor_po_id: '',
      po_date: '',
      po_expiry_date: '',
      city: '',
      status: 'Open',
      party_name: '',
      lines: [{ line_no: 1, item_code: '', qty: 1 }],
    });
    setMode('manual');
  };

  const handleApprove = async () => {
    if (!summary.vendor_po_id) return toast.error('Vendor PO No. is required');
    if (!summary.city) return toast.error('City is required');
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
    setMode(null);
    setFile(null);
  };

  return (
    <AppShell>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-[#003049]">Add Purchase Order</h1>
        <p className="text-gray-500 text-sm">Upload a PDF to import, or add a PO manually.</p>
      </div>

      {!summary && (
        <form onSubmit={handleParse} className="bg-white rounded-xl border border-gray-200 p-6 space-y-4 max-w-2xl">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Vendor</label>
            <select required value={vendor} onChange={e => setVendor(e.target.value)} className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30">
              <option value="">Select vendor...</option>
              {vendors.map(v => <option key={v.id} value={v.name}>{v.name}{!v.has_parser ? ' (no parser yet)' : ''}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">PO PDF</label>
            <input type="file" accept="application/pdf,.pdf" onChange={e => setFile(e.target.files?.[0] || null)} className="w-full text-sm file:mr-3 file:px-3 file:py-2 file:rounded-lg file:border-0 file:bg-[#003049] file:text-white file:cursor-pointer" />
            <p className="text-xs text-gray-400 mt-1">Max 10 MB. PDF files only. Leave blank to add manually.</p>
          </div>
          <div className="flex gap-3 justify-end flex-wrap">
            <Button type="button" variant="ghost" onClick={() => navigate('/purchase-orders')}>Cancel</Button>
            <Button type="button" variant="outline" onClick={handleAddManually}><Pencil size={16} />Add Manually</Button>
            <Button type="submit" loading={parsing}><Upload size={16} />Parse PDF</Button>
          </div>
        </form>
      )}

      {summary && (
        <div className="space-y-5">
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm text-blue-900">
            {mode === 'manual'
              ? 'Enter the PO details below, then approve to save.'
              : 'Review the parsed data below. Edit any field inline before approving. Rejecting discards this upload.'}
          </div>
          <SummaryEditor value={summary} onChange={setSummary} showVendor readOnlyVendor={mode !== 'manual'} />
          <div className="flex gap-3 justify-end">
            <Button variant="ghost" onClick={handleReject}><X size={16} />{mode === 'manual' ? 'Cancel' : 'Reject'}</Button>
            <Button onClick={handleApprove} loading={committing}><Check size={16} />{mode === 'manual' ? 'Save PO' : 'Approve & Save'}</Button>
          </div>
        </div>
      )}

      <Modal
        isOpen={!!parserMissing}
        onClose={() => setParserMissing(null)}
        title="Parser not implemented"
        size="md"
      >
        {parserMissing && (
          <div className="space-y-4 -mx-6 -my-4 px-6 py-4 border-y bg-amber-50 border-amber-200">
            <p className="text-sm text-amber-700 font-medium">
              {parserMissing.message}
            </p>
            <p className="text-sm text-gray-700">
              The vendor <span className="font-semibold">{parserMissing.vendor}</span> exists in the system but does not yet have a PDF parser implementation. Until a parser is added in code, POs for this vendor cannot be uploaded via PDF. You can still add the PO manually from this screen.
            </p>
            <div className="flex justify-end">
              <Button onClick={() => setParserMissing(null)}>OK</Button>
            </div>
          </div>
        )}
      </Modal>
    </AppShell>
  );
}
