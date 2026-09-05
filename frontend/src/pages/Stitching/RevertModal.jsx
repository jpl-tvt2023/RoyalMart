import { useState } from 'react';
import toast from 'react-hot-toast';
import Modal from '../../components/ui/Modal';
import Button from '../../components/ui/Button';
import { revertStitchingLot } from '../../api/stitching.api';
import { REVERT_REASON_MAX, revertReasonError, fmtQty } from '../../utils/stitching';

const inputCls = 'w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f]';

/**
 * Send a wrongly recorded hop back to the stage it came from.
 *
 * This is a CORRECTION, not rework — nothing physically moved, someone recorded
 * the forward against the wrong lot or stage. The hop is retired rather than
 * erased, and the reason is required, because the whole value of the record is
 * that "why is there a retired hop here" stays answerable later.
 */
export default function RevertModal({ lot, onClose, onSaved }) {
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    const err = revertReasonError(reason);
    if (err) { toast.error(err); return; }
    setSaving(true);
    try {
      await revertStitchingLot(lot.src, lot.id, reason.trim());
      toast.success(`Sent back to ${lot.parent_stage}`);
      onSaved?.();
      onClose();
    } catch (err2) {
      toast.error(err2.response?.data?.message || 'Could not send this back');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title={`Send back to ${lot.parent_stage}`} size="md">
      <form onSubmit={submit}>
        <div className="rounded-lg bg-gray-50 border border-gray-200 px-4 py-3 mb-4 text-sm text-gray-600">
          <span className="font-semibold text-[#003049]">{fmtQty(lot.sent_qty, lot.unit_metric)}</span> returns to
          the <span className="font-medium text-[#003049]">{lot.parent_stage}</span> lot, which
          becomes forwardable again. This {lot.stage} entry is kept as a record, struck through,
          not deleted.
        </div>

        <label className="block text-xs font-medium text-gray-600 mb-1">
          Reason<span className="text-red-500"> *</span>
        </label>
        <textarea
          autoFocus
          rows={3}
          value={reason}
          onChange={e => setReason(e.target.value)}
          className={inputCls}
          maxLength={REVERT_REASON_MAX}
          placeholder="e.g. recorded against the wrong lot"
        />

        <p className="mt-2 text-[11px] text-gray-400">
          Use this when the hop should not exist — material that never moved, or moved against the
          wrong lot. Send it back, then forward it again correctly.
        </p>

        <div className="flex justify-end gap-2 mt-5">
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="danger" loading={saving} disabled={!reason.trim()}>
            Send back
          </Button>
        </div>
      </form>
    </Modal>
  );
}
