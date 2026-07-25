import { useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import Modal from '../../components/ui/Modal';
import Button from '../../components/ui/Button';
import { Download, Upload, FileSpreadsheet } from 'lucide-react';
import toast from 'react-hot-toast';

function defaultSummarise({ inserted, updated, skipped }) {
  const parts = [];
  if (inserted) parts.push(`${inserted} new row${inserted !== 1 ? 's' : ''} added`);
  if (updated)  parts.push(`${updated} existing row${updated !== 1 ? 's' : ''} updated`);
  if (!parts.length) return skipped.length
    ? `No changes saved — all ${skipped.length} row${skipped.length !== 1 ? 's were' : ' was'} skipped.`
    : 'No changes — your file matched what was already saved.';
  let msg = parts.join(' and ') + '.';
  if (skipped.length) msg += ` ${skipped.length} row${skipped.length !== 1 ? 's' : ''} skipped.`;
  return msg;
}

// Map an arbitrary parsed row onto the configured headers, normalising keys
// (trim, lowercase, spaces → underscores) so header casing/spacing is forgiving.
function normaliseRow(raw, headers) {
  const out = {};
  for (const key of Object.keys(raw)) {
    const k = String(key).trim().toLowerCase().replace(/\s+/g, '_');
    out[k] = typeof raw[key] === 'string' ? raw[key].trim() : raw[key];
  }
  const picked = {};
  for (const h of headers) picked[h] = out[h] ?? '';
  return picked;
}

function downloadTemplate(config) {
  const ws = XLSX.utils.aoa_to_sheet([config.headers, config.sampleRow]);
  ws['!cols'] = config.headers.map(() => ({ wch: 18 }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Template');
  XLSX.writeFile(wb, config.templateFileName);
}

export default function BulkUploadModal({ isOpen, onClose, onDone, config }) {
  const fileRef = useRef(null);
  const [file, setFile] = useState(null);
  const [rows, setRows] = useState([]);
  const [parseErr, setParseErr] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);

  const { headers, sampleRow, requiredKeys = [], instructions, summarise = defaultSummarise } = config;

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
      const keysToCheck = requiredKeys.length ? requiredKeys : headers;
      const normalised = raw
        .map(r => normaliseRow(r, headers))
        .filter(r => keysToCheck.some(k => String(r[k] ?? '').trim() !== ''));
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
      const r = await config.submit(rows);
      const data = r.data ?? r;
      setResult(data);
      toast.success(summarise(data), { duration: 5000 });
      onDone?.();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Upload failed');
    } finally { setSubmitting(false); }
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title={config.title} size="lg">
      <div className="space-y-4">
        <div className="border border-gray-200 rounded-lg p-4 bg-gray-50">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2 text-sm font-semibold text-[#003049]">
              <FileSpreadsheet size={16} /> Template columns
            </div>
            <button type="button" onClick={() => downloadTemplate(config)} className="inline-flex items-center gap-1 text-sm text-[#c1121f] hover:underline">
              <Download size={14} /> Download template
            </button>
          </div>
          <div className="overflow-x-auto scrollbar-thin">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-white border border-gray-200">
                  {headers.map(h => (
                    <th key={h} className="px-2 py-1.5 text-left font-semibold text-gray-700 border-r border-gray-200 last:border-r-0">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr className="border border-gray-200 border-t-0">
                  {sampleRow.map((c, i) => (
                    <td key={i} className="px-2 py-1.5 font-mono text-gray-600 border-r border-gray-200 last:border-r-0">{String(c)}</td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
          {instructions && (
            <p className="text-xs text-gray-500 mt-2">{instructions}</p>
          )}
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
          <div className="border border-emerald-200 bg-emerald-50 rounded-lg p-4 text-sm">
            <p className="font-medium text-emerald-800">Upload complete</p>
            <ul className="mt-2 space-y-1 text-gray-800">
              {result.inserted > 0 && (
                <li><span className="font-semibold text-emerald-700">{result.inserted}</span> new row{result.inserted !== 1 ? 's' : ''} added.</li>
              )}
              {result.updated > 0 && (
                <li><span className="font-semibold text-blue-700">{result.updated}</span> existing row{result.updated !== 1 ? 's' : ''} updated with new details.</li>
              )}
              {result.inserted === 0 && result.updated === 0 && result.skipped.length === 0 && (
                <li className="text-gray-600">No changes — your file matched what was already saved.</li>
              )}
              {result.skipped.length > 0 && (
                <li><span className="font-semibold text-amber-700">{result.skipped.length}</span> row{result.skipped.length !== 1 ? 's' : ''} skipped (missing info or invalid value).</li>
              )}
            </ul>
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
