import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import Modal from '../../components/ui/Modal';
import Button from '../../components/ui/Button';
import { listUsersLite } from '../../api/users.api';
import { receiveStitchingChallan } from '../../api/stitching.api';
import { ROLES } from '../../utils/roles';
import { defaultAfterRate, fmtNum, fmtQty, moneyError, qtyError } from '../../utils/stitching';

const inputCls = 'w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f]';
const labelCls = 'block text-xs font-medium text-gray-600 mb-1';

const EMPTY = { metre: '', process_rate: '', after_rate: '', checked_by: '' };

function Field({ label, required, children, hint }) {
  return (
    <div>
      <label className={labelCls}>
        {label}{required && <span className="text-red-500"> *</span>}
      </label>
      {children}
      {hint && <p className="mt-1 text-[11px] text-gray-400">{hint}</p>}
    </div>
  );
}

/**
 * Record what came back against a challan.
 *
 * The second half of the move. A challan returns in one delivery, so this fills
 * in the row the dispatch created rather than making another — what arrived,
 * what the stage cost, and who checked it. Anything short of what was sent is
 * process loss.
 */
export default function ReceiveModal({ challan, onClose, onSaved }) {
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [checkers, setCheckers] = useState([]);
  // Once the user types an After Rate it stops tracking Rate + Process Rate,
  // matching what the server stores.
  const [afterRatePinned, setAfterRatePinned] = useState(false);

  const carriedRate = Number(challan?.rate || 0);
  const unit = challan?.unit_metric;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const users = await listUsersLite({ role: ROLES.WAREHOUSE_POC });
        if (!cancelled) setCheckers(users || []);
      } catch {
        if (!cancelled) toast.error('Could not load the form options');
      }
    })();
    return () => { cancelled = true; };
  }, [challan?.id]);

  const setField = (k, v) => setForm(f => {
    const next = { ...f, [k]: v };
    if (k === 'after_rate') return next;
    if (k === 'process_rate' && !afterRatePinned) {
      next.after_rate = defaultAfterRate(carriedRate, v);
    }
    return next;
  });

  // Mirrors the server's rules AND their order.
  const fieldError = () => {
    const metreErr = qtyError(form.metre, 'Received Qty');
    if (metreErr) return metreErr;
    const procErr = moneyError(form.process_rate, 'Process Rate');
    if (procErr) return procErr;
    const afterErr = moneyError(form.after_rate, 'After Rate');
    if (afterErr) return afterErr;
    if (!form.checked_by) return 'Checked By is required';
    return null;
  };

  const submit = async (e) => {
    e.preventDefault();
    const err = fieldError();
    if (err) { toast.error(err); return; }
    setSaving(true);
    try {
      await receiveStitchingChallan(challan.id, {
        metre: Number(form.metre),
        process_rate: form.process_rate === '' ? null : Number(form.process_rate),
        after_rate: form.after_rate === '' ? null : Number(form.after_rate),
        checked_by: Number(form.checked_by),
      });
      toast.success(`Received at ${challan.stage}`);
      onSaved();
    } catch (err2) {
      toast.error(err2.response?.data?.message || 'Could not record the receipt');
    } finally {
      setSaving(false);
    }
  };

  if (!challan) return null;
  const loss = form.metre !== '' ? Number(challan.sent_qty) - Number(form.metre) : null;

  return (
    <Modal isOpen onClose={onClose} title={`Receive at ${challan.stage}`} size="lg">
      <form onSubmit={submit} className="space-y-4">
        <div className="rounded-lg bg-gray-50 border border-gray-200 px-4 py-3 text-sm">
          <div className="font-medium text-[#003049]">
            {challan.item_name}{challan.variant ? ` — ${challan.variant}` : ''}
          </div>
          <div className="text-gray-500 text-xs mt-0.5">
            Challan {challan.challan_no || '—'} · {challan.party_name} · PO {challan.po_order_no}
          </div>
          <div className="text-gray-600 text-xs mt-1">
            Sent <span className="font-semibold text-[#003049]">{fmtQty(challan.sent_qty, unit)}</span>
            {' · carried-in rate '}
            <span className="font-semibold text-[#003049]">{fmtNum(challan.rate)}</span>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field
            label="Received Qty"
            required
            hint={loss != null && loss > 0 ? `Loss of ${fmtQty(loss, unit)}` : 'What actually came back'}
          >
            <input
              autoFocus
              type="number" min={0.01} step="0.01"
              value={form.metre}
              onChange={e => setField('metre', e.target.value)}
              className={inputCls}
            />
          </Field>

          <Field label="Checked By" required>
            <select
              value={form.checked_by}
              onChange={e => setField('checked_by', e.target.value)}
              className={inputCls}
            >
              <option value="">Select...</option>
              {checkers.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </Field>

          <Field label="Rate" hint="The previous stage's After Rate — edit it there">
            <input value={fmtNum(challan.rate)} disabled className={`${inputCls} bg-gray-50 text-gray-500`} />
          </Field>

          <Field label="Process Rate" hint={`What ${challan.stage.toLowerCase()} cost per unit`}>
            <input
              type="number" min={0} step="0.01"
              value={form.process_rate}
              onChange={e => setField('process_rate', e.target.value)}
              className={inputCls}
            />
          </Field>

          <Field
            label="After Rate"
            hint={afterRatePinned ? 'Overridden — clear it to go back to Rate + Process Rate' : 'Rate + Process Rate'}
          >
            <input
              type="number" min={0} step="0.01"
              value={form.after_rate}
              onChange={e => { setAfterRatePinned(e.target.value !== ''); setField('after_rate', e.target.value); }}
              className={inputCls}
            />
          </Field>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={saving}>Receive</Button>
        </div>
      </form>
    </Modal>
  );
}
