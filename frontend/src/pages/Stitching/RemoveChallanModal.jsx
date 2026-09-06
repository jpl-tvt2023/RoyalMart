import { useState } from 'react';
import toast from 'react-hot-toast';
import Modal from '../../components/ui/Modal';
import Button from '../../components/ui/Button';
import { removeStitchingChallan } from '../../api/stitching.api';
import { REVERT_REASON_MAX, revertReasonError, fmtQty } from '../../utils/stitching';

const inputCls = 'w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f]';

/**
 * Withdraw a challan, or a write-off, that should not exist.
 *
 * A CORRECTION, not a movement. Material flows one way only, and nothing here
 * sends anything back: this erases a dispatch that was recorded wrongly — most
 * often one entered against the wrong PO. The quantity never actually left; only
 * the record said it had, so it simply stops counting as dispatched.
 *
 * No stage is named anywhere in this dialog, deliberately.
 */
export default function RemoveChallanModal({ challan, onClose, onSaved }) {
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    const err = revertReasonError(reason);
    if (err) { toast.error(err); return; }
    setSaving(true);
    try {
      await removeStitchingChallan(challan.id, reason.trim());
      toast.success(challan.is_write_off ? 'Write-off withdrawn' : 'Challan withdrawn');
      onSaved?.();
      onClose();
    } catch (err2) {
      toast.error(err2.response?.data?.message || 'Could not withdraw this');
    } finally {
      setSaving(false);
    }
  };

  if (!challan) return null;

  return (
    <Modal isOpen onClose={onClose} title={challan.is_write_off ? 'Withdraw write-off' : 'Withdraw challan'} size="md">
      <form onSubmit={submit}>
        <div className="rounded-lg bg-gray-50 border border-gray-200 px-4 py-3 mb-4 text-sm text-gray-600">
          {challan.is_write_off ? (
            <>
              The write-off of{' '}
              <span className="font-semibold text-[#003049]">
                {fmtQty(challan.sent_qty, challan.unit_metric)}
              </span>{' '}
              stops counting as gone, and that quantity is available again on the lot it was taken
              from. It is kept as a record, struck through, not deleted.
            </>
          ) : (
            <>
              Challan <span className="font-semibold text-[#003049]">{challan.challan_no || '—'}</span> for{' '}
              <span className="font-semibold text-[#003049]">
                {fmtQty(challan.sent_qty, challan.unit_metric)}
              </span>{' '}
              to {challan.party_name} stops counting as sent, and that quantity is available again on
              the lot it was taken from. The challan is kept as a record, struck through, not deleted.
            </>
          )}
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
          placeholder={challan.is_write_off
            ? 'e.g. the bundle was found'
            : 'e.g. entered against the wrong PO'}
        />

        <p className="mt-2 text-[11px] text-gray-400">
          {challan.is_write_off
            ? 'Use this when the material turned out not to be lost, or the quantity was wrong.'
            : 'Use this when the challan should not exist — recorded against the wrong lot, or never actually raised. Then enter it against the right one.'}
        </p>

        <div className="flex justify-end gap-2 mt-5">
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="danger" loading={saving} disabled={!reason.trim()}>
            {challan.is_write_off ? 'Withdraw write-off' : 'Withdraw challan'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
