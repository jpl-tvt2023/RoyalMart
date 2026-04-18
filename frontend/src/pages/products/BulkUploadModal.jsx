import { useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import Modal from '../../components/ui/Modal';
import Button from '../../components/ui/Button';
import { bulkUpsertVendorCodes } from '../../api/productVendorCodes.api';
import { Download, Upload, FileSpreadsheet } from 'lucide-react';
import toast from 'react-hot-toast';

const HEADERS = ['sku_code', 'vendor', 'vendor_item_code', 'product_description'];
const SAMPLE_ROW = ['BND-RED-S1', 'Swiggy', 'SWG-12345', 'Red Cotton Bandana (Single Pack)'];

function downloadTemplate(existing = []) {
  const dataRows = existing.length
    ? existing.map(r => [r.sku_code || '', r.vendor || '', r.vendor_item_code || '', r.product_description || ''])
    : [SAMPLE_ROW];
  const ws = XLSX.utils.aoa_to_sheet([HEADERS, ...dataRows]);
  ws['!cols'] = [{ wch: 18 }, { wch: 14 }, { wch: 20 }, { wch: 40 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Mappings');
  XLSX.writeFile(wb, 'product-vendor-mappings-template.xlsx');
}

function normaliseRow(raw) {
  const out = {};
  for (const key of Object.keys(raw)) {
    const k = String(key).trim().toLowerCase().replace(/\s+/g, '_');
    out[k] = typeof raw[key] === 'string' ? raw[key].trim() : raw[key];
  }
  return {
    sku_code: out.sku_code ?? '',
    vendor: out.vendor ?? '',
    vendor_item_code: out.vendor_item_code ?? '',
    product_description: out.product_description ?? '',
  };
}

export default function BulkUploadModal({ isOpen, onClose, onDone, existingRows = [] }) {
  const fileRef = useRef(null);
  const [file, setFile] = useState(null);
  const [rows, setRows] = useState([]);
  const [parseErr, setParseErr] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);

  const reset = () => {
    setFile(null); setRows([]); setParseErr(''); setResult(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  const handleClose = () => { reset(); onClose(); };

  const handleFile = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setResult(null); setParseErr(''); setRows([]);
    const okExt = /\.xlsx$/i.test(f.name);
    const okMime = !f.type || f.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    if (!okExt || !okMime) {
      setParseErr('Only .xlsx files are accepted.');
      setFile(null);
      if (fileRef.current) fileRef.current.value = '';
      return;
    }
    setFile(f);
    try {
      const buf = await f.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const raw = XLSX.utils.sheet_to_json(ws, { defval: '' });
      const normalised = raw.map(normaliseRow).filter(r => r.sku_code || r.vendor || r.vendor_item_code);
      if (!normalised.length) {
        setParseErr('No data rows found. Check column headers match the template.');
        return;
      }
      setRows(normalised);
    } catch (err) {
      setParseErr(err.message || 'Failed to parse file');
    }
  };

  const handleSubmit = async () => {
    if (!rows.length) return;
    setSubmitting(true);
    try {
      const r = await bulkUpsertVendorCodes(rows);
      setResult(r.data);
      toast.success(`+${r.data.inserted} inserted · ~${r.data.updated} updated · !${r.data.skipped.length} skipped`);
      onDone?.();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Upload failed');
    } finally { setSubmitting(false); }
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Bulk Upload Vendor Mappings" size="lg">
      <div className="space-y-4">
        <div className="border border-gray-200 rounded-lg p-4 bg-gray-50">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2 text-sm font-semibold text-[#003049]">
              <FileSpreadsheet size={16} /> Template columns
            </div>
            <button type="button" onClick={() => downloadTemplate(existingRows)} className="inline-flex items-center gap-1 text-sm text-[#c1121f] hover:underline">
              <Download size={14} /> {existingRows.length ? `Download current data (${existingRows.length})` : 'Download template'}
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-white border border-gray-200">
                  {HEADERS.map(h => (
                    <th key={h} className="px-2 py-1.5 text-left font-semibold text-gray-700 border-r border-gray-200 last:border-r-0">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr className="border border-gray-200 border-t-0">
                  {SAMPLE_ROW.map((c, i) => (
                    <td key={i} className="px-2 py-1.5 font-mono text-gray-600 border-r border-gray-200 last:border-r-0">{c}</td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
          <p className="text-xs text-gray-500 mt-2">
            Upsert key is <code>vendor + vendor_item_code</code>. Existing rows with the same pair will have their product and description overwritten.
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Select .xlsx file</label>
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={handleFile}
            className="block w-full text-sm text-gray-700 file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-[#003049] file:text-white hover:file:bg-[#002439]"
          />
          {parseErr && <p className="mt-2 text-sm text-red-600">{parseErr}</p>}
          {file && !parseErr && rows.length > 0 && (
            <p className="mt-2 text-sm text-gray-600">Parsed <span className="font-semibold">{rows.length}</span> row{rows.length !== 1 ? 's' : ''} from <span className="font-mono">{file.name}</span>.</p>
          )}
        </div>

        {result && (
          <div className="border border-gray-200 rounded-lg p-3 text-sm">
            <div className="flex gap-4 font-medium">
              <span className="text-emerald-700">+{result.inserted} inserted</span>
              <span className="text-blue-700">~{result.updated} updated</span>
              <span className="text-amber-700">!{result.skipped.length} skipped</span>
            </div>
            {result.skipped.length > 0 && (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-gray-600">Show skipped rows</summary>
                <ul className="mt-2 max-h-40 overflow-y-auto text-xs text-gray-700 space-y-1">
                  {result.skipped.map((s, i) => (
                    <li key={i}>Row {s.row}: {s.reason}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}

        <div className="flex gap-3 justify-end pt-2">
          <Button variant="ghost" type="button" onClick={handleClose}>Close</Button>
          <Button type="button" loading={submitting} disabled={!rows.length || !!result} onClick={handleSubmit}>
            <Upload size={16} /> Upload {rows.length ? `(${rows.length})` : ''}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
