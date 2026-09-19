import { useState } from 'react';
import toast from 'react-hot-toast';
import Modal from '../../components/ui/Modal';
import Button from '../../components/ui/Button';
import { writeOffStitchingQty } from '../../api/stitching.api';
import {
  WRITE_OFF_REASON_MAX, writeOffReasonError, qtyError, fmtQty, EPSILON,
} from '../../utils/stitching';

const inputCls = 'w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f]';

/**
 * Write material off a lot.
 *
 * Fabric ruined at rest, or a challan that went out and never came back. The
 * quantity leaves the lot and never arrives anywhere — which is why this is not
 * a stage move and names no destination.
 *
 * The reason is mandatory: "where did 60 go" has to stay answerable a year from
 * now, and the number alone cannot answer it.
 */
export default function WriteOffModal({ lot, onClose, onSaved }) {
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  const unit = lot?.unit_metric;

  // Mirrors the server's rules AND their order.
  const fieldError = () => {
    const reasonErr = writeOffReasonError(reason);
    if (reasonErr) return reasonErr;
    const qErr = qtyError(qty, 'Qty');
    if (qErr) return qErr;
    if (Number(qty) - Number(lot.balance) > EPSILON) {
      return `Cannot write off ${qty} — only ${fmtQty(lot.balance, unit)} is left on this lot`;
    }
    return null;
  };

  const submit = async (e) => {
    e.preventDefault();
    const err = fieldError();
    if (err) { toast.error(err); return; }
    setSaving(true);
    try {
      await writeOffStitchingQty({
        parent_src: lot.src,
        parent_id: lot.id,
        qty: Number(qty),
        reason: reason.trim(),
      });
      toast.success(`Wrote off ${fmtQty(Number(qty), unit)}`);
      onSaved();
    } catch (err2) {
      toast.error(err2.response?.data?.message || 'Could not write this off');
    } finally {
      setSaving(false);
    }
  };

  if (!lot) return null;

  return (
    <Modal isOpen onClose={onClose} title="Write off" size="md">
      <form onSubmit={submit} className="space-y-4">
        <div className="rounded-lg bg-gray-50 border border-gray-200 px-4 py-3 text-sm">
          <div className="font-medium text-[#003049]">
            {lot.item_name}{lot.variant ? ` — ${lot.variant}` : ''}
          </div>
          <div className="text-gray-500 text-xs mt-0.5">
            {lot.stage} · {lot.party_name} · PO {lot.po_order_no}
          </div>
          <div className="text-gray-600 text-xs mt-1">
            Available <span className="font-semibold text-[#003049]">{fmtQty(lot.balance, unit)}</span>
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">
            Qty<span className="text-red-500"> *</span>
          </label>
          <input
            autoFocus
            type="number" min={0.01} step="0.01" max={lot.balance}
            value={qty}
            onChange={e => setQty(e.target.value)}
            className={inputCls}
          />
          <p className="mt-1 text-[11px] text-gray-400">
            Comes off this lot&apos;s balance. It is not sent anywhere.
          </p>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">
            Reason<span className="text-red-500"> *</span>
          </label>
          <textarea
            rows={3}
            value={reason}
            onChange={e => setReason(e.target.value)}
            className={inputCls}
            maxLength={WRITE_OFF_REASON_MAX}
            placeholder="e.g. water damage in storage"
          />
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="danger" loading={saving} disabled={!reason.trim()}>
            Write off
          </Button>
        </div>
      </form>
    </Modal>
  );
}
