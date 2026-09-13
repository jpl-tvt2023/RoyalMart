import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import Modal from '../../components/ui/Modal';
import Button from '../../components/ui/Button';
import {
  listStitchingPartyNames, addStitchingChallan, updateStitchingLot,
} from '../../api/stitching.api';
import {
  CHALLAN_MAX, CHALLAN_TYPES, challanError, qtyError, moneyError, fmtNum, fmtQty, EPSILON,
  destinationsFor, nextStage, shortOf, EXIT_STAGE, DESTINATION_HINTS,
  countsDozens, metresPerDozen, rateUnitFor,
} from '../../utils/stitching';

const inputCls = 'w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f]';
const labelCls = 'block text-xs font-medium text-gray-600 mb-1';

const EMPTY = {
  challan_no: '', party_name: '', sent_qty: '', received_qty: '',
  // Nothing pre-selected, deliberately. A grade the user did not choose is
  // worse than one they have to pick, so this stays blank until they do.
  challan_type: '',
  received_dozens: '',
  process_rate: '', outbound_bill_no: '',
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
 * Send part of a lot somewhere: the next stage, a later one, the warehouse, or
 * out of the business to a buyer.
 *
 * ONE ACT, not two. Adding a challan is sending the lot on, so this records the
 * whole hand-over — what left, what came back and what the stage cost. There is
 * no in-transit state to fill in later.
 *
 * ONE DECISION, not two either. The destination is picked once, from tiles that
 * name the real places this lot can go, and the rest of the form reshapes around
 * it: the party list narrows to parties who do that job, the rate takes that
 * stage's name, and a sale asks for the outbound bill it needs. The alternative
 * — a "next stage / third party" dropdown, then a second prompt for which stage
 * — asks the same question twice and makes the user hold an abstraction ("is the
 * warehouse a next stage?") that the tiles simply answer.
 *
 * The partial part is the point: 40 of a 100 lot can go to Stitched and the
 * remaining 60 straight to a buyer, each drawing the balance down.
 *
 * EDIT MODE. Pass `challan` and this corrects an existing row instead of
 * creating one. A wrongly entered challan could previously only be withdrawn and
 * re-raised, which loses the row and its history for what is usually a typo. The
 * server has always accepted the PATCH — only the way in was missing.
 *
 * What edit mode does NOT offer is the destination. Moving a challan to another
 * stage would relocate a live lot and everything hanging off it, which is not
 * what "fix the challan number" means. Withdraw and re-raise for that.
 *
 * There is no Bill No for an internal move, and no Checked By anywhere. A
 * challan is not a bill — only a sale carries one. And Checked By records who
 * entered the row, which the server takes from the session rather than asking
 * someone to pick their own name from a dropdown.
 */
export default function ChallanModal({ lot, challan = null, onClose, onSaved }) {
  const isEdit = !!challan;
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [parties, setParties] = useState([]);
  const [partiesLoaded, setPartiesLoaded] = useState(false);
  // On an edit the destination is fixed — it is where the row already sits.
  const [target, setTarget] = useState(challan?.stage || nextStage(lot?.stage));

  const options = destinationsFor(lot?.stage);
  const unit = lot?.unit_metric || 'm';
  const poRate = Number(lot?.po_rate || 0);
  const isExit = target === EXIT_STAGE;
  // Pieces only exist once there are pieces: Stitched and Packed count dozens,
  // and their rate is quoted per dozen rather than per metre.
  const isDozenStage = countsDozens(target);
  const perDozen = metresPerDozen(form.received_qty, form.received_dozens);
  // What this challan may draw on. On an edit the row's own sent_qty is already
  // counted in the parent's forwarded total, so add it back — the same
  // arithmetic the server's update() does.
  const available = Number(lot?.balance || 0) + (isEdit ? Number(challan?.sent_qty || 0) : 0);

  // Refetched whenever the destination changes, not once on mount: the list is
  // narrowed by where the goods are going, and the master can change under an
  // already-open tab anyway. Same fix as the outbound vendor catalog
  // stale-dropdown bug.
  useEffect(() => {
    let cancelled = false;
    setPartiesLoaded(false);
    (async () => {
      try {
        const names = await listStitchingPartyNames(target);
        if (cancelled) return;
        setParties(names || []);
        setPartiesLoaded(true);
        // A party valid for the old destination may not be valid for the new
        // one, and silently keeping a name the server will reject is worse than
        // clearing it.
        setForm(f => (f.party_name && !(names || []).includes(f.party_name)
          ? { ...f, party_name: '' } : f));
      } catch {
        if (!cancelled) toast.error('Could not load the party list');
      }
    })();
    return () => { cancelled = true; };
  }, [lot?.lot_key, target]);

  // Prefill once per challan being edited.
  useEffect(() => {
    if (!challan) return;
    setForm({
      challan_no: challan.challan_no ?? '',
      party_name: challan.party_name ?? '',
      sent_qty: challan.sent_qty ?? '',
      received_qty: challan.received_qty ?? '',
      challan_type: challan.challan_type ?? '',
      received_dozens: challan.received_dozens ?? '',
      process_rate: challan.process_rate ?? '',
      outbound_bill_no: challan.outbound_bill_no ?? '',
    });
    setTarget(challan.stage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [challan?.id]);

  const setField = (k, v) => setForm(f => {
    const next = { ...f, [k]: v };
    // Received defaults to what was sent, since nothing short is the normal
    // case. Typing over it is what records a shortage.
    if (!isEdit && k === 'sent_qty' && (f.received_qty === '' || f.received_qty === f.sent_qty)) {
      next.received_qty = v;
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
    if (!isExit) {
      const recdErr = qtyError(form.received_qty, 'Received Qty');
      if (recdErr) return recdErr;
      if (Number(form.received_qty) - Number(form.sent_qty) > EPSILON) {
        return 'Received Qty cannot be more than Sent Qty';
      }
    }
    if (isDozenStage && qtyError(form.received_dozens, 'Dozens Received')) {
      return qtyError(form.received_dozens, 'Dozens Received');
    }
    if (!form.challan_type) return 'Challan Type is required';
    const procErr = moneyError(form.process_rate, `${target} Rate`);
    if (procErr) return procErr;
    if (isExit && !String(form.outbound_bill_no || '').trim()) {
      return 'Outbound Bill No is required when sending to a third party';
    }
    const challanErr = challanError(form.challan_no);
    if (challanErr) return challanErr;
    if (Number(form.sent_qty) - available > EPSILON) {
      return `Cannot send ${form.sent_qty} — only ${fmtQty(available, unit)} is left on this lot`;
    }
    return null;
  };

  const submit = async (e) => {
    e.preventDefault();
    const err = fieldError();
    if (err) { toast.error(err); return; }
    setSaving(true);
    const payload = {
      challan_no: form.challan_no.trim(),
      party_name: form.party_name.trim(),
      sent_qty: Number(form.sent_qty),
      // Nothing comes BACK from a sale — the goods left for good. Sent is what
      // reached the buyer, so the shortfall is 0 rather than the whole quantity.
      received_qty: isExit ? Number(form.sent_qty) : Number(form.received_qty),
      challan_type: form.challan_type,
      received_dozens: isDozenStage && form.received_dozens !== ''
        ? Number(form.received_dozens) : null,
      process_rate: form.process_rate === '' ? null : Number(form.process_rate),
      outbound_bill_no: isExit ? form.outbound_bill_no.trim() : null,
    };
    try {
      if (isEdit) {
        // No parent and no target stage: an edit corrects this row where it
        // stands, it does not move it.
        await updateStitchingLot(challan.id, payload);
        toast.success(`Challan ${payload.challan_no} updated`);
      } else {
        await addStitchingChallan({
          parent_src: lot.src, parent_id: lot.id, target_stage: target, ...payload,
        });
        toast.success(isExit
          ? `Sold ${form.sent_qty} to ${payload.party_name}`
          : `Sent ${form.sent_qty} to ${target}`);
      }
      onSaved();
    } catch (err2) {
      toast.error(err2.response?.data?.message
        || (isEdit ? 'Could not update the challan' : 'Could not add the challan'));
    } finally {
      setSaving(false);
    }
  };

  if (!lot) return null;
  const short = shortOf(form.sent_qty, form.received_qty);

  return (
    <Modal isOpen onClose={onClose} title={isEdit ? 'Edit Challan' : 'Add Challan'} size="lg">
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
            Available <span className="font-semibold text-[#003049]">{fmtQty(available, unit)}</span>
            {' of '}{fmtQty(lot.received_qty, unit)}
            {' · PO rate '}<span className="font-semibold text-[#003049]">{fmtNum(poRate)}</span>
          </div>
        </div>

        {/* ONE decision, made first, with the real destinations named. A stage
            with a single destination still shows its tile rather than hiding the
            step — the user should be able to see where the goods are going. */}
        <div>
          <label className={labelCls}>
            Send this lot to <span className="text-red-500">*</span>
          </label>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {options.map(dest => {
              const selected = dest === target;
              return (
                <button
                  type="button"
                  key={dest}
                  onClick={() => !isEdit && setTarget(dest)}
                  disabled={isEdit && !selected}
                  aria-pressed={selected}
                  className={`rounded-lg border px-3 py-2 text-left transition ${
                    selected
                      ? 'border-[#c1121f] bg-[#c1121f]/5 ring-2 ring-[#c1121f]/20'
                      : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                  } ${isEdit && !selected ? 'opacity-40 cursor-not-allowed' : ''}`}
                >
                  <div className={`text-sm font-medium ${selected ? 'text-[#c1121f]' : 'text-[#003049]'}`}>
                    {dest}
                  </div>
                  <div className="text-[11px] text-gray-400 leading-tight">
                    {DESTINATION_HINTS[dest]}
                  </div>
                </button>
              );
            })}
          </div>
          {isEdit && (
            <p className="mt-1 text-[11px] text-gray-400">
              An edit corrects this challan where it is. To send it somewhere else, withdraw it and raise a new one.
            </p>
          )}
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

          {/* A dropdown, not free text. The master replaced the old datalist:
              typing meant every spelling variant became a new party, and nothing
              stopped a packer being named for stitching work. Already narrowed
              to parties tagged for this destination. */}
          <Field
            label="Party Name"
            required
            hint={partiesLoaded && !parties.length
              ? `No party is tagged for ${target} — add one in Admin → Purchase Config`
              : (isExit ? 'Who the goods are sold to' : `Who the ${target?.toLowerCase()} work goes to`)}
          >
            <select
              value={form.party_name}
              onChange={e => setField('party_name', e.target.value)}
              className={inputCls}
            >
              <option value="">Select...</option>
              {parties.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </Field>

          <Field
            label={`Sent Qty (${unit})`}
            required
            hint={`At most ${fmtQty(available, unit)} — the rest stays at ${lot.stage}`}
          >
            <input
              type="number" min={0.01} step="0.01" max={available}
              value={form.sent_qty}
              onChange={e => setField('sent_qty', e.target.value)}
              className={inputCls}
            />
          </Field>

          {/* Sits next to Sent Qty because it describes the goods being sent,
              not the hand-over. */}
          <Field label="Challan Type" required hint="The grade of goods on this challan">
            <select
              value={form.challan_type}
              onChange={e => setField('challan_type', e.target.value)}
              className={inputCls}
            >
              <option value="">Select...</option>
              {CHALLAN_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>

          {/* Nothing comes back from a sale, so there is nothing to ask. */}
          {!isExit && (
            <Field
              label={`Received Qty (${unit})`}
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
          )}

          {/* Dozens sit under the metres they are counted from, and the yield
              sits beside them, so the arithmetic is visible as it is typed
              rather than discovered later on a report. */}
          {isDozenStage && !isExit && (
            <Field
              label="Dozens Received"
              required
              hint="How many dozen came back on this challan"
            >
              <input
                type="number" min={0.01} step="0.01"
                value={form.received_dozens}
                onChange={e => setField('received_dozens', e.target.value)}
                className={inputCls}
              />
            </Field>
          )}

          {isDozenStage && !isExit && (
            <Field
              label="Metre per Dozen"
              hint="Metres divided by dozens — the yield. Worked out for you"
            >
              <input
                value={perDozen == null ? '' : fmtNum(perDozen)}
                disabled
                className={`${inputCls} bg-gray-50 text-gray-500`}
              />
            </Field>
          )}

          {isExit && (
            <Field
              label="Outbound Bill No"
              required
              hint="Our invoice for the sale — the only handle on goods that have left"
            >
              <input
                value={form.outbound_bill_no}
                onChange={e => setField('outbound_bill_no', e.target.value)}
                className={inputCls}
                maxLength={50}
                placeholder="e.g. OB-4471"
              />
            </Field>
          )}

          {/* Named for the stage the work lands at, and holding only that
              stage's charge. Rates no longer roll up into a running total — each
              stage keeps its own, and the lot's ladder shows them side by side
              against the PO rate. */}
          <Field
            label={`${target} Rate${isDozenStage && !isExit ? ' (per dozen)' : ''}`}
            hint={isExit
              ? 'What this sale is booked at, per metre'
              : `What ${target?.toLowerCase()} costs per ${rateUnitFor(target)}`}
          >
            <input
              type="number" min={0} step="0.01"
              value={form.process_rate}
              onChange={e => setField('process_rate', e.target.value)}
              className={inputCls}
            />
          </Field>

          <Field label="PO Rate" hint="From the PO receipt this lot came in on — edit it there">
            <input value={fmtNum(poRate)} disabled className={`${inputCls} bg-gray-50 text-gray-500`} />
          </Field>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={saving}>{isEdit ? 'Save' : 'Send'}</Button>
        </div>
      </form>
    </Modal>
  );
}
