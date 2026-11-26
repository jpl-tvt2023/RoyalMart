import { useState } from 'react';
import toast from 'react-hot-toast';
import { Printer } from 'lucide-react';
import Modal from '../../components/ui/Modal';
import Button from '../../components/ui/Button';
import { printLabelBatch } from '../../api/station.api';
import { articleLabel, packSizeLabel, keyCountLabel, printCountLabel } from '../../utils/barcodeStation';
import { inputCls, loadKeyEncoder, toPrintJob } from './stationHelpers';

// Print an entry's labels from the station -- all of them, or a run of label
// numbers (a jammed roll, a damaged sticker) -- without a sticker or a key ever
// appearing on screen. The keys come back from the logged print call and go
// straight to PrintPortal. Reprints are allowed any number of times; every one
// is logged with the operator's name.
export default function PrintLabelsModal({ batch, operator, printMode, onClose, onJob }) {
  const n = batch.label_count;
  const [scope, setScope] = useState('all');
  const [from, setFrom] = useState('1');
  const [to, setTo] = useState(String(n));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // The server's own message, so both sides read alike.
  const rangeError = () => {
    if (scope === 'all') return null;
    const a = Number(from);
    const b = Number(to);
    if (!/^\d+$/.test(from) || !/^\d+$/.test(to) || a < 1 || b > n || a > b) return `Labels must be a range within 1 to ${n}`;
    return null;
  };

  const submit = async (e) => {
    e.preventDefault();
    const err = rangeError();
    if (err) { setError(err); return; }
    setBusy(true);
    try {
      const range = scope === 'all' ? {} : { from: Number(from), to: Number(to) };
      const [data, encode] = await Promise.all([printLabelBatch(batch.id, operator, range), loadKeyEncoder()]);
      onJob(toPrintJob(data, encode));
    } catch (ex) {
      const status = ex.response?.status;
      const message = ex.response?.data?.message || 'Print failed';
      if (status === 400 || status === 409) setError(message);
      else if (status !== 401) toast.error(message);
      setBusy(false);
    }
  };

  const radio = (value, label) => (
    <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
      <input type="radio" name="print-scope" checked={scope === value} onChange={() => { setScope(value); setError(''); }} />
      {label}
    </label>
  );

  return (
    <Modal isOpen onClose={onClose} title={`Print batch #${batch.id}`} size="md">
      <form onSubmit={submit} className="space-y-4" noValidate>
        <div className="text-sm bg-gray-50 rounded-lg p-3 space-y-0.5">
          <p className="font-medium text-[#003049]">{batch.vendor_name}</p>
          <p className="text-gray-600">{articleLabel(batch)}</p>
          <p className="text-gray-600">
            Pack of {packSizeLabel(batch)} · {batch.floor_name} · {keyCountLabel(n)} · {printCountLabel(batch.print_count)}
          </p>
        </div>

        <div className="space-y-2">
          {radio('all', `All ${n} label${n !== 1 ? 's' : ''}`)}
          {radio('range', 'Only some labels')}
          {scope === 'range' && (
            <div className="flex items-end gap-2 pl-6">
              <label className="block w-24">
                <span className="block text-xs font-medium text-gray-600 mb-1">From label</span>
                <input value={from} onChange={(e) => { setFrom(e.target.value.replace(/\D/g, '')); setError(''); }} className={inputCls} inputMode="numeric" />
              </label>
              <label className="block w-24">
                <span className="block text-xs font-medium text-gray-600 mb-1">To label</span>
                <input value={to} onChange={(e) => { setTo(e.target.value.replace(/\D/g, '')); setError(''); }} className={inputCls} inputMode="numeric" />
              </label>
            </div>
          )}
        </div>

        {printMode === 'direct' ? (
          <p className="text-xs text-gray-500">The labels go straight to the label printer. Nothing is shown on screen.</p>
        ) : (
          <p className="text-xs text-gray-500">
            Your browser&apos;s print dialog will open. Pick the label printer, set the paper to the sticker size,
            scale 100% (Actual size), margins None, and turn off headers and footers.
          </p>
        )}

        {error && <p className="text-sm text-[#c1121f]">{error}</p>}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" loading={busy}><Printer size={15} /> Print</Button>
        </div>
      </form>
    </Modal>
  );
}
