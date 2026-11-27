import { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import toast from 'react-hot-toast';
import { Download, Printer, Search } from 'lucide-react';
import Modal from '../../components/ui/Modal';
import Button from '../../components/ui/Button';
import { getLabelBatchKeysAdmin } from '../../api/labelBatches.api';
import { articleLabel, packSizeLabel, keyCountLabel } from '../../utils/barcodeStation';
import { formatDateTime } from '../../utils/formatters';
import { inputCls, openPrintSheet } from './stationHelpers';

// Local copy of the house XLSX helper (see frontend/CLAUDE.md: it is
// duplicated per page by design).
function downloadRows(filename, columns, rows) {
  const header = columns.map((c) => c.header);
  const data = rows.map((r) => columns.map((c) => (r[c.key] == null ? '' : r[c.key])));
  const ws = XLSX.utils.aoa_to_sheet([header, ...data]);
  ws['!cols'] = header.map(() => ({ wch: 20 }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Keys');
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
  XLSX.writeFile(wb, `${filename}-${stamp}.xlsx`);
}

// ADMIN ONLY. Every key of one batch: Label # -> Key, from the Admin API
// (labelBatches.api.js -- the station API has no route that shows keys). A
// filter box finds a label by its number or key, and a range opens the print
// preview for just those stickers (a damaged roll, a box that lost its label).
// `highlightKey` marks the key a search found.
export default function KeysModal({ batch, highlightKey, onClose }) {
  const [keys, setKeys] = useState(null);
  const [filter, setFilter] = useState('');
  const [from, setFrom] = useState('1');
  const [to, setTo] = useState(String(batch.label_count));

  useEffect(() => {
    let cancelled = false;
    getLabelBatchKeysAdmin(batch.id)
      .then((data) => { if (!cancelled) setKeys(data.keys); })
      .catch((err) => {
        if (cancelled) return;
        toast.error(err.response?.data?.message || 'Could not load the keys');
        setKeys([]);
      });
    return () => { cancelled = true; };
  }, [batch.id]);

  const shown = useMemo(() => {
    const q = filter.trim();
    if (!keys || !q) return keys || [];
    return keys.filter((k) => String(k.label_key).includes(q) || String(k.label_no) === q);
  }, [keys, filter]);

  const n = batch.label_count;
  const rangeError = (() => {
    const a = Number(from);
    const b = Number(to);
    if (!/^\d+$/.test(from) || !/^\d+$/.test(to) || a < 1 || b > n || a > b) return `Labels must be a range within 1 to ${n}`;
    return null;
  })();

  const exportKeys = () => {
    downloadRows(`label-batch-${batch.id}-keys`, [
      { header: 'Label #', key: 'label_no' },
      { header: 'Key', key: 'label_key' },
      { header: 'Vendor Name', key: 'vendor' },
      { header: 'Stitching / Packing', key: 'party' },
      { header: 'Article', key: 'article' },
      { header: 'Pack Size', key: 'pack' },
      { header: 'Date of Incoming', key: 'date' },
    ], (keys || []).map((k) => ({
      ...k,
      vendor: batch.vendor_name,
      party: batch.stitching_party_name || '',
      article: articleLabel(batch),
      pack: packSizeLabel(batch),
      date: formatDateTime(batch.generated_at),
    })));
  };

  return (
    <Modal isOpen onClose={onClose} title={`Batch #${batch.id} · ${keyCountLabel(n)}`} size="xl">
      <div className="space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3 text-sm bg-gray-50 rounded-lg p-3">
          <div><p className="text-xs text-gray-500">Vendor Name</p><p className="font-medium text-[#003049]">{batch.vendor_name}</p></div>
          <div><p className="text-xs text-gray-500">Stitching / Packing</p><p className="font-medium text-[#003049]">{batch.stitching_party_name || '—'}</p></div>
          <div className="col-span-2"><p className="text-xs text-gray-500">Article</p><p className="font-medium text-[#003049]">{articleLabel(batch)}</p></div>
          <div><p className="text-xs text-gray-500">Pack Size</p><p className="font-medium text-[#003049]">{packSizeLabel(batch)}</p></div>
          <div><p className="text-xs text-gray-500">Date of Incoming</p><p className="font-medium text-[#003049]">{formatDateTime(batch.generated_at)}</p></div>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <label className="block flex-1 min-w-[200px]">
            <span className="block text-xs font-medium text-gray-600 mb-1">Find a label</span>
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value.replace(/\D/g, ''))}
                className={`${inputCls} pl-8`}
                placeholder="Key or label number"
                inputMode="numeric"
              />
            </div>
          </label>
          <div className="flex items-end gap-2">
            <label className="block w-20">
              <span className="block text-xs font-medium text-gray-600 mb-1">From label</span>
              <input value={from} onChange={(e) => setFrom(e.target.value.replace(/\D/g, ''))} className={inputCls} inputMode="numeric" />
            </label>
            <label className="block w-20">
              <span className="block text-xs font-medium text-gray-600 mb-1">To label</span>
              <input value={to} onChange={(e) => setTo(e.target.value.replace(/\D/g, ''))} className={inputCls} inputMode="numeric" />
            </label>
            <Button
              variant="secondary"
              onClick={() => (rangeError ? toast.error(rangeError) : openPrintSheet(batch.id, from, to))}
            >
              <Printer size={15} /> Print range
            </Button>
          </div>
          <Button variant="outline" onClick={exportKeys} disabled={!keys?.length}>
            <Download size={15} /> Export
          </Button>
        </div>

        {keys == null ? (
          <p className="text-sm text-gray-500 py-6 text-center">Loading keys…</p>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2 max-h-[45vh] overflow-y-auto pr-1">
              {shown.map((k) => {
                const hit = highlightKey != null && Number(highlightKey) === k.label_key;
                return (
                  <div
                    key={k.label_key}
                    className={`flex items-center justify-between gap-2 rounded-lg border px-3 py-1.5 ${hit ? 'border-[#c1121f] bg-red-50' : 'border-gray-200 bg-white'}`}
                  >
                    <span className="text-xs text-gray-400 tabular-nums">#{k.label_no}</span>
                    <span className="font-mono text-sm font-semibold text-[#003049] tracking-wider">{k.label_key}</span>
                    <button
                      type="button"
                      onClick={() => openPrintSheet(batch.id, k.label_no, k.label_no)}
                      className="p-1 rounded text-gray-400 hover:text-[#003049] hover:bg-gray-100"
                      title={`Print label #${k.label_no} again`}
                    >
                      <Printer size={13} />
                    </button>
                  </div>
                );
              })}
            </div>
            {!shown.length && <p className="text-sm text-gray-500 text-center py-4">No label matches “{filter}”.</p>}
          </>
        )}
      </div>
    </Modal>
  );
}
