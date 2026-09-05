import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import Modal from '../../components/ui/Modal';
import Button from '../../components/ui/Button';
import { listStitchingParties, dispatchStitchingChallan } from '../../api/stitching.api';
import { listStitchingPrefixes } from '../../api/stitchingPrefixes.api';
import {
  CHALLAN_MAX, challanError, qtyError, fmtQty, EPSILON,
  carriedIncomingNo, soleActivePrefix, nextStage,
} from '../../utils/stitching';

const inputBase = 'px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f]';
const inputCls = `w-full ${inputBase}`;
const labelCls = 'block text-xs font-medium text-gray-600 mb-1';

const EMPTY = { challan_no: '', party_name: '', sent_qty: '' };

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
 * Record a challan: part of `lot` dispatched to a processor.
 *
 * The dispatch half only. Nothing has come back yet, so there is no received
 * quantity, no rates and no checker here — that is ReceiveModal. The quantity
 * leaves the lot's balance the moment this is saved, which is the point: 40 of a
 * 100 lot can be out at a processor while 60 waits for instructions.
 */
export default function ChallanModal({ lot, onClose, onSaved }) {
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [parties, setParties] = useState([]);
  const [prefix, setPrefix] = useState(null);
  const [prefixLoaded, setPrefixLoaded] = useState(false);

  const target = nextStage(lot?.stage);
  const unit = lot?.unit_metric;

  // Refetched on open, not once on mount: the party list and the prefix master
  // can change under an already-open tab, and the server validates against the
  // live rows. Same fix as the outbound vendor catalog stale-dropdown bug.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [party, pfx] = await Promise.all([listStitchingParties(), listStitchingPrefixes()]);
        if (cancelled) return;
        setParties(party || []);
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

  const setField = (k, v) => setForm(f => ({ ...f, [k]: v }));

  // Mirrors the server's rules AND their order, so the message shown here is the
  // one the server would have returned.
  const fieldError = () => {
    if (!String(form.party_name || '').trim()) return 'Party Name is required';
    if (!String(form.challan_no || '').trim()) return 'Challan No is required';
    const challanErr = challanError(form.challan_no);
    if (challanErr) return challanErr;
    const sentErr = qtyError(form.sent_qty, 'Sent Qty');
    if (sentErr) return sentErr;
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
      await dispatchStitchingChallan({
        parent_src: lot.src,
        parent_id: lot.id,
        challan_no: form.challan_no.trim(),
        party_name: form.party_name.trim(),
        sent_qty: Number(form.sent_qty),
      });
      toast.success(`Challan added — ${form.sent_qty} sent to ${form.party_name.trim()}`);
      onSaved();
    } catch (err2) {
      toast.error(err2.response?.data?.message || 'Could not add the challan');
    } finally {
      setSaving(false);
    }
  };

  if (!lot) return null;

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
            {' of '}{fmtQty(lot.metre, unit)} · going to{' '}
            <span className="font-semibold text-[#003049]">{target}</span>
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

          {/* Not a field. The prefix belongs to the stage the goods are going to
              and the number carries down the chain, so there is nothing to
              choose — the server derives both and this only reports them. */}
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
          <Button type="submit" loading={saving}>Add Challan</Button>
        </div>
      </form>
    </Modal>
  );
}
