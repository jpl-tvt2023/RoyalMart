import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import Modal from '../../components/ui/Modal';
import Button from '../../components/ui/Button';
import { listUsersLite } from '../../api/users.api';
import { listStitchingParties, addStitchingChallan } from '../../api/stitching.api';
import { listStitchingPrefixes } from '../../api/stitchingPrefixes.api';
import { ROLES } from '../../utils/roles';
import {
  CHALLAN_MAX, challanError, qtyError, moneyError, fmtNum, fmtQty, EPSILON,
  carriedIncomingNo, soleActivePrefix, nextStage, defaultAfterRate, shortOf,
} from '../../utils/stitching';

const inputCls = 'w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f]';
const labelCls = 'block text-xs font-medium text-gray-600 mb-1';

const EMPTY = {
  challan_no: '', party_name: '', sent_qty: '', received_qty: '',
  process_rate: '', after_rate: '', checked_by: '',
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
 * Add a challan: part of `lot` sent on to the next stage.
 *
 * ONE ACT, not two. Adding a challan is sending the lot on, so this records the
 * whole hand-over — what left, what came back, what the stage cost and who
 * checked it. There is no in-transit state to fill in later.
 *
 * The partial part is the point: 40 of a 100 lot can go out under one challan
 * and the remaining 60 under another, each drawing the balance down.
 *
 * There is no Bill No here. A challan is not a bill, and the only bill number in
 * the system stays on the PO receipt.
 */
export default function ChallanModal({ lot, onClose, onSaved }) {
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [parties, setParties] = useState([]);
  const [checkers, setCheckers] = useState([]);
  const [prefix, setPrefix] = useState(null);
  const [prefixLoaded, setPrefixLoaded] = useState(false);
  // Once the user types an After Rate it stops tracking Rate + Process Rate,
  // matching what the server stores.
  const [afterRatePinned, setAfterRatePinned] = useState(false);

  const target = nextStage(lot?.stage);
  const unit = lot?.unit_metric;
  const carriedRate = Number(lot?.after_rate || 0);

  // Refetched on open, not once on mount: the party list, the checker list and
  // the prefix master can all change under an already-open tab, and the server
  // validates against the live rows. Same fix as the outbound vendor catalog
  // stale-dropdown bug.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [party, pfx, users] = await Promise.all([
          listStitchingParties(),
          listStitchingPrefixes(),
          listUsersLite({ role: ROLES.WAREHOUSE_POC }),
        ]);
        if (cancelled) return;
        setParties(party || []);
        setCheckers(users || []);
        setPrefix(soleActivePrefix(pfx, target));
        setPrefixLoaded(true);
      } catch {
        if (!cancelled) toast.error('Could not load the form options');
      }
    })();
    return () => { cancelled = true; };
    // Keyed on the lot identity, not the object: this runs once per lot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lot?.lot_key]);

  const setField = (k, v) => setForm(f => {
    const next = { ...f, [k]: v };
    // Received defaults to what was sent, since nothing short is the normal
    // case. Typing over it is what records a shortage.
    if (k === 'sent_qty' && (f.received_qty === '' || f.received_qty === f.sent_qty)) {
      next.received_qty = v;
    }
    if (k === 'process_rate' && !afterRatePinned) {
      next.after_rate = defaultAfterRate(carriedRate, v);
    }
    return next;
  });

  // Mirrors the server's rules AND their order, so the message shown here is the
  // one the server would have returned.
  const fieldError = () => {
    if (!String(form.party_name || '').trim()) return 'Party Name is required';
    if (!String(form.challan_no || '').trim()) return 'Challan No is required';
    const sentErr = qtyError(form.sent_qty, 'Sent Qty');
    if (sentErr) return sentErr;
    const recdErr = qtyError(form.received_qty, 'Received Qty');
    if (recdErr) return recdErr;
    if (Number(form.received_qty) - Number(form.sent_qty) > EPSILON) {
      return 'Received Qty cannot be more than Sent Qty';
    }
    const procErr = moneyError(form.process_rate, 'Process Rate');
    if (procErr) return procErr;
    const afterErr = moneyError(form.after_rate, 'After Rate');
    if (afterErr) return afterErr;
    if (!form.checked_by) return 'Checked By is required';
    const challanErr = challanError(form.challan_no);
    if (challanErr) return challanErr;
    if (Number(form.sent_qty) - Number(lot.balance) > EPSILON) {
      return `Cannot send ${form.sent_qty} — only ${fmtQty(lot.balance, unit)} is left on this lot`;
    }
    return null;
  };

  const submit = async (e) => {
    e.preventDefault();
    const err = fieldError();
    if (err) { toast.error(err); return; }
    setSaving(true);
    try {
      await addStitchingChallan({
        parent_src: lot.src,
        parent_id: lot.id,
        challan_no: form.challan_no.trim(),
        party_name: form.party_name.trim(),
        sent_qty: Number(form.sent_qty),
        received_qty: Number(form.received_qty),
        process_rate: form.process_rate === '' ? null : Number(form.process_rate),
        after_rate: form.after_rate === '' ? null : Number(form.after_rate),
        checked_by: Number(form.checked_by),
      });
      toast.success(`Sent ${form.sent_qty} to ${target}`);
      onSaved();
    } catch (err2) {
      toast.error(err2.response?.data?.message || 'Could not add the challan');
    } finally {
      setSaving(false);
    }
  };

  if (!lot) return null;
  const short = shortOf(form.sent_qty, form.received_qty);

  return (
    <Modal isOpen onClose={onClose} title="Add Challan" size="lg">
      <form onSubmit={submit} className="space-y-4">
        <div className="rounded-lg bg-gray-50 border border-gray-200 px-4 py-3 text-sm">
          <div className="font-medium text-[#003049]">
            {lot.item_name}{lot.variant ? ` — ${lot.variant}` : ''}
          </div>
          <div className="text-gray-500 text-xs mt-0.5">
            {lot.stage} · {lot.party_name} · PO {lot.po_order_no}
            {lot.incoming_prefix || lot.incoming_no
              ? ` · ${lot.incoming_prefix || ''}${lot.incoming_no || ''}` : ''}
          </div>
          <div className="text-gray-600 text-xs mt-1">
            Available <span className="font-semibold text-[#003049]">{fmtQty(lot.balance, unit)}</span>
            {' of '}{fmtQty(lot.received_qty, unit)} · going to{' '}
            <span className="font-semibold text-[#003049]">{target}</span>
            {' · carried-in rate '}
            <span className="font-semibold text-[#003049]">{fmtNum(carriedRate)}</span>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Challan No" required>
            <input
              autoFocus
              value={form.challan_no}
              onChange={e => setField('challan_no', e.target.value)}
              className={inputCls}
              maxLength={CHALLAN_MAX}
              placeholder="e.g. 12345"
            />
          </Field>

          <Field label="Party Name" required hint={`Who the ${target?.toLowerCase()} work goes to`}>
            <input
              list="stitching-parties"
              value={form.party_name}
              onChange={e => setField('party_name', e.target.value)}
              className={inputCls}
              maxLength={50}
            />
            <datalist id="stitching-parties">
              {parties.map(p => <option key={p} value={p} />)}
            </datalist>
          </Field>

          <Field
            label="Sent Qty"
            required
            hint={`At most ${fmtQty(lot.balance, unit)} — the rest stays at ${lot.stage}`}
          >
            <input
              type="number" min={0.01} step="0.01" max={lot.balance}
              value={form.sent_qty}
              onChange={e => setField('sent_qty', e.target.value)}
              className={inputCls}
            />
          </Field>

          <Field
            label="Received Qty"
            required
            hint={short != null && short > 0
              ? `${fmtQty(short, unit)} short`
              : 'What actually came back'}
          >
            <input
              type="number" min={0.01} step="0.01"
              value={form.received_qty}
              onChange={e => setField('received_qty', e.target.value)}
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

          <Field label="Rate" hint="Carried in from this lot — edit it there">
            <input value={fmtNum(carriedRate)} disabled className={`${inputCls} bg-gray-50 text-gray-500`} />
          </Field>

          <Field label="Process Rate" hint={`What ${target?.toLowerCase()} costs per unit`}>
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

          {/* Not a field. The prefix belongs to the stage the goods are going to
              and the number carries down the chain, so there is nothing to
              choose — the server derives both and this only reports them. Two
              challans out of one lot therefore share a number, by design: it
              identifies the material, and the challan numbers tell them apart. */}
          <Field
            label={`${target} incoming no`}
            hint={prefixLoaded && !prefix
              ? `No active ${target} prefix — add one in Admin → Purchase Config`
              : 'Set automatically from the stage and this lot'}
          >
            <div className={`${inputCls} bg-gray-50 text-gray-600 font-mono`}>
              {prefix
                ? `${prefix.prefix}${carriedIncomingNo(lot)}`
                : <span className="text-gray-400">—</span>}
            </div>
          </Field>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={saving}>Send</Button>
        </div>
      </form>
    </Modal>
  );
}
