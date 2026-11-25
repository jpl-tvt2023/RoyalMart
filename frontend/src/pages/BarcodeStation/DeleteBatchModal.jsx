import { useState } from 'react';
import toast from 'react-hot-toast';
import { AlertTriangle } from 'lucide-react';
import Modal from '../../components/ui/Modal';
import Button from '../../components/ui/Button';
import { deleteLabelBatch } from '../../api/station.api';
import {
  deleteReasonError, articleLabel, packSizeLabel, keyCountLabel, DELETE_REASON_MAX,
} from '../../utils/barcodeStation';
import { formatDateTime } from '../../utils/formatters';

// Delete a GENERATED batch (099). Its stickers may already be on boxes, so a
// reason is required and the operator is told plainly what happens: the keys
// are retired -- never reused -- and a scan of one says the entry was deleted.
// A draft never opens this; it deletes through a plain confirm.
export default function DeleteBatchModal({ batch, operator, onClose, onDeleted }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const n = batch.key_count || batch.label_count;

  const submit = async (e) => {
    e.preventDefault();
    const err = deleteReasonError(reason, true);
    if (err) { setError(err); return; }
    setBusy(true);
    try {
      await deleteLabelBatch(batch.id, operator, reason.trim());
      toast.success(`Batch #${batch.id} deleted — ${keyCountLabel(n)} retired`);
      onDeleted();
    } catch (ex) {
      const status = ex.response?.status;
      const message = ex.response?.data?.message || 'Delete failed';
      if (status === 400 || status === 409) setError(message);
      else if (status !== 401) toast.error(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title={`Delete batch #${batch.id}?`} size="md">
      <form onSubmit={submit} className="space-y-4" noValidate>
        <div className="text-sm bg-gray-50 rounded-lg p-3 space-y-0.5">
          <p className="font-medium text-[#003049]">{batch.vendor_name}</p>
          <p className="text-gray-600">{articleLabel(batch)}</p>
          <p className="text-gray-600">
            Pack of {packSizeLabel(batch)} · {batch.floor_name} · {keyCountLabel(n)} · generated {formatDateTime(batch.generated_at)}
          </p>
        </div>

        <div className="flex gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          <AlertTriangle size={16} className="shrink-0 mt-0.5" />
          <p>
            Its {n} printed sticker{n !== 1 ? 's' : ''} stop being valid — their keys are retired and never
            reused, and scanning one will say this entry was deleted. Remove or cross out the stickers.
            This cannot be undone.
          </p>
        </div>

        <label className="block">
          <span className="block text-xs font-medium text-gray-600 mb-1">Reason</span>
          <textarea
            autoFocus
            rows={3}
            maxLength={DELETE_REASON_MAX}
            value={reason}
            onChange={(e) => { setReason(e.target.value); setError(''); }}
            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30"
            placeholder="e.g. Wrong vendor picked, trial entry"
          />
          <span className="block text-xs text-gray-400 text-right">{reason.length}/{DELETE_REASON_MAX}</span>
        </label>

        {error && <p className="text-sm text-[#c1121f]">{error}</p>}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" variant="danger" loading={busy}>Delete entry</Button>
        </div>
      </form>
    </Modal>
  );
}
