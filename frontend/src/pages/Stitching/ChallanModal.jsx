import { useState } from 'react';
import toast from 'react-hot-toast';
import Modal from '../../components/ui/Modal';
import Button from '../../components/ui/Button';
import { setStitchingChallan } from '../../api/stitching.api';
import { CHALLAN_MAX, challanError, nextStage } from '../../utils/stitching';

const inputCls = 'w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f]';

/**
 * The challan a lot is dispatched under.
 *
 * Works on both kinds of lot, which is the point: an origin lot is a PO receipt,
 * and this is the only place the Stitching page can write one. Clearing is
 * allowed — the consequence is simply that the lot can no longer be sent ahead.
 */
export default function ChallanModal({ lot, onClose, onSaved }) {
  const [value, setValue] = useState(lot?.challan_no ?? '');
  const [saving, setSaving] = useState(false);

  const target = nextStage(lot?.stage);
  const clearing = !String(value).trim();

  const submit = async (e) => {
    e.preventDefault();
    const err = challanError(value);
    if (err) { toast.error(err); return; }
    setSaving(true);
    try {
      await setStitchingChallan(lot.src, lot.id, String(value).trim() || null);
      toast.success(clearing ? 'Challan cleared' : 'Challan saved');
      onSaved?.();
      onClose();
    } catch (err2) {
      toast.error(err2.response?.data?.message || 'Could not save the challan');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title="Challan No" size="sm">
      <form onSubmit={submit}>
        <p className="text-sm text-gray-500 mb-4">
          The challan this <span className="font-medium text-[#003049]">{lot.stage}</span> lot is
          sent out under{target ? <> to <span className="font-medium text-[#003049]">{target}</span></> : null}.
        </p>

        <input
          autoFocus
          value={value}
          onChange={e => setValue(e.target.value)}
          className={inputCls}
          maxLength={CHALLAN_MAX}
          placeholder="e.g. 4471"
        />

        {/* Only worth saying when it is about to become true. */}
        {clearing && lot.challan_no && (
          <p className="mt-2 text-[11px] text-amber-600">
            Clearing this means the lot can no longer be sent ahead until a challan is added again.
          </p>
        )}

        <div className="flex justify-end gap-2 mt-5">
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={saving}>Save</Button>
        </div>
      </form>
    </Modal>
  );
}
