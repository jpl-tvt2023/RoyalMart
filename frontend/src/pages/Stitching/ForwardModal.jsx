import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import Modal from '../../components/ui/Modal';
import Button from '../../components/ui/Button';
import { listUsersLite } from '../../api/users.api';
import { listStitchingPrefixes } from '../../api/stitchingPrefixes.api';
import { listStitchingParties, forwardStitchingLot } from '../../api/stitching.api';
import { ROLES } from '../../utils/roles';
import { defaultAfterRate, fmtNum, moneyError, qtyError, EPSILON } from '../../utils/stitching';

const inputCls = 'w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f]';
const labelCls = 'block text-xs font-medium text-gray-600 mb-1';

const EMPTY = {
  party_name: '', sent_qty: '', metre: '', process_rate: '', after_rate: '',
  bill_no: '', challan_no: '', incoming_prefix_id: '', incoming_no: '', checked_by: '',
};

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
 * Send part or all of `lot` on to the next stage.
 *
 * The target stage is not a field — the server derives it from the parent, and
 * this only displays it. Rate is likewise read-only: it is whatever the parent
 * lot's After Rate is, and editing it here would mean editing the parent.
 */
export default function ForwardModal({ lot, onClose, onSaved }) {
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [checkers, setCheckers] = useState([]);
  const [prefixes, setPrefixes] = useState([]);
  const [parties, setParties] = useState([]);
  // Once the user types an After Rate it stops tracking Rate + Process Rate,
  // matching what the server stores.
  const [afterRatePinned, setAfterRatePinned] = useState(false);

  const carriedRate = Number(lot?.after_rate || 0);

  // Refetched every time the modal opens, not once on page mount: the prefix
  // master and the user list can change under an already-open tab, and the
  // server validates against the live rows. Same fix as the outbound vendor
  // catalog stale-dropdown bug.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [users, pfx, party] = await Promise.all([
          listUsersLite({ role: ROLES.WAREHOUSE_POC }),
          listStitchingPrefixes(),
          listStitchingParties(),
        ]);
        if (cancelled) return;
        setCheckers(users || []);
        setPrefixes(pfx || []);
        setParties(party || []);
      } catch {
        if (!cancelled) toast.error('Could not load the form options');
      }
    })();
    return () => { cancelled = true; };
  }, [lot?.lot_key]);

  // Only prefixes belonging to the stage this lot is moving to — the server
  // rejects any other, so offering them would be a trap.
  const stagePrefixes = useMemo(
    () => prefixes.filter(p => p.stage === lot?.next_stage && p.is_active),
    [prefixes, lot?.next_stage],
  );

  const setField = (k, v) => setForm(f => {
    const nextForm = { ...f, [k]: v };
    if (k === 'after_rate') return nextForm;
    if (k === 'process_rate' && !afterRatePinned) {
      nextForm.after_rate = defaultAfterRate(carriedRate, v);
    }
    return nextForm;
  });

  // Mirrors the server's rules AND their order, so the message shown here is the
  // one the server would have returned.
  const fieldError = () => {
    if (!String(form.party_name || '').trim()) return 'Party Name is required';
    const sentErr = qtyError(form.sent_qty, 'Sent Metre');
    if (sentErr) return sentErr;
    if (Number(form.sent_qty) - Number(lot.balance) > EPSILON) {
      return `Cannot send ${form.sent_qty} — only ${fmtNum(lot.balance)} is left on this lot`;
    }
    const metreErr = qtyError(form.metre, 'Received Metre');
    if (metreErr) return metreErr;
    const procErr = moneyError(form.process_rate, 'Process Rate');
    if (procErr) return procErr;
    const afterErr = moneyError(form.after_rate, 'After Rate');
    if (afterErr) return afterErr;
    if (!form.checked_by) return 'Checked By is required';
    if (form.incoming_prefix_id && !String(form.incoming_no || '').trim()) {
      return 'Incoming No is required when a prefix is selected';
    }
    return null;
  };

  const submit = async (e) => {
    e.preventDefault();
    const err = fieldError();
    if (err) { toast.error(err); return; }
    setSaving(true);
    try {
      await forwardStitchingLot({
        parent_src: lot.src,
        parent_id: lot.id,
        party_name: form.party_name.trim(),
        sent_qty: Number(form.sent_qty),
        metre: Number(form.metre),
        process_rate: form.process_rate === '' ? null : Number(form.process_rate),
        after_rate: form.after_rate === '' ? null : Number(form.after_rate),
        bill_no: form.bill_no.trim() || null,
        challan_no: form.challan_no.trim() || null,
        incoming_prefix_id: form.incoming_prefix_id || null,
        incoming_no: form.incoming_no.trim() || null,
        checked_by: Number(form.checked_by),
      });
      toast.success(`Sent to ${lot.next_stage}`);
      onSaved();
    } catch (err2) {
      toast.error(err2.response?.data?.message || 'Could not send this lot');
    } finally {
      setSaving(false);
    }
  };

  if (!lot) return null;
  const shrinkage = form.sent_qty !== '' && form.metre !== ''
    ? Number(form.sent_qty) - Number(form.metre) : null;

  return (
    <Modal isOpen onClose={onClose} title={`Send to ${lot.next_stage}`} size="lg">
      <form onSubmit={submit} className="space-y-4">
        <div className="rounded-lg bg-gray-50 border border-gray-200 px-4 py-3 text-sm">
          <div className="font-medium text-[#003049]">
            {lot.item_name}{lot.variant ? ` — ${lot.variant}` : ''}
          </div>
          <div className="text-gray-500 text-xs mt-0.5">
            From {lot.stage} · {lot.party_name} · PO {lot.po_order_no}
            {lot.incoming_prefix || lot.incoming_no
              ? ` · ${lot.incoming_prefix || ''}${lot.incoming_no || ''}` : ''}
          </div>
          <div className="text-gray-600 text-xs mt-1">
            Available <span className="font-semibold text-[#003049]">{fmtNum(lot.balance)}</span>
            {' of '}{fmtNum(lot.metre)} · carried-in rate{' '}
            <span className="font-semibold text-[#003049]">{fmtNum(lot.after_rate)}</span>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Party Name" required hint="Who is doing this stage">
            <input
              list="stitching-parties"
              value={form.party_name}
              onChange={e => setField('party_name', e.target.value)}
              className={inputCls}
              maxLength={50}
              required
            />
            <datalist id="stitching-parties">
              {parties.map(p => <option key={p} value={p} />)}
            </datalist>
          </Field>

          <Field label="Checked By" required>
            <select
              value={form.checked_by}
              onChange={e => setField('checked_by', e.target.value)}
              className={inputCls}
              required
            >
              <option value="">Select...</option>
              {checkers.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </Field>

          <Field label="Sent Metre" required hint={`At most ${fmtNum(lot.balance)}`}>
            <input
              type="number" min={0.01} step="0.01" max={lot.balance}
              value={form.sent_qty}
              onChange={e => setField('sent_qty', e.target.value)}
              className={inputCls}
              required
            />
          </Field>

          <Field
            label="Received Metre"
            required
            hint={shrinkage != null && shrinkage > 0 ? `Loss of ${fmtNum(shrinkage)}` : 'What actually came back'}
          >
            <input
              type="number" min={0.01} step="0.01"
              value={form.metre}
              onChange={e => setField('metre', e.target.value)}
              className={inputCls}
              required
            />
          </Field>

          <Field label="Rate" hint="The previous stage's After Rate — edit it there">
            <input value={fmtNum(lot.after_rate)} disabled className={`${inputCls} bg-gray-50 text-gray-500`} />
          </Field>

          <Field label="Process Rate">
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

          <Field label="Bill No">
            <input value={form.bill_no} onChange={e => setField('bill_no', e.target.value)} className={inputCls} maxLength={50} />
          </Field>

          <Field label="Challan No">
            <input value={form.challan_no} onChange={e => setField('challan_no', e.target.value)} className={inputCls} maxLength={50} />
          </Field>

          <Field
            label="Incoming No"
            hint={stagePrefixes.length ? undefined : `No active ${lot.next_stage} prefix — add one in Admin → Purchase Config`}
          >
            <div className="flex gap-2">
              <select
                value={form.incoming_prefix_id}
                onChange={e => setField('incoming_prefix_id', e.target.value)}
                className={`${inputCls} w-28 shrink-0`}
              >
                <option value="">Prefix</option>
                {stagePrefixes.map(p => <option key={p.id} value={p.id}>{p.prefix}</option>)}
              </select>
              <input
                value={form.incoming_no}
                onChange={e => setField('incoming_no', e.target.value)}
                className={inputCls}
                maxLength={50}
                placeholder="e.g. 0077"
              />
            </div>
          </Field>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={saving}>Send to {lot.next_stage}</Button>
        </div>
      </form>
    </Modal>
  );
}
