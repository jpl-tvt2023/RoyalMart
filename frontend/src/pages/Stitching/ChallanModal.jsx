import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Plus, X } from 'lucide-react';
import Modal from '../../components/ui/Modal';
import Button from '../../components/ui/Button';
import {
  listStitchingPartyNames, addStitchingChallan, updateStitchingLot,
} from '../../api/stitching.api';
import { listUsersLite } from '../../api/users.api';
import { ROLES } from '../../utils/roles';
import { checkerOptionsFor } from '../../utils/checkers';
import {
  CHALLAN_MAX, CHALLAN_TYPES, challanError, qtyError, moneyError, fmtNum, EPSILON,
  destinationsFor, nextStage, EXIT_STAGE, STOCK_STAGE, DESTINATION_HINTS,
  countsDozens, metresPerDozen, stageRateLabel,
} from '../../utils/stitching';

const inputCls = 'w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f]';
const cellInputCls = 'w-full px-2 py-1.5 border border-gray-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f]';
const labelCls = 'block text-xs font-medium text-gray-600 mb-1';

const EMPTY_HEADER = {
  challan_no: '', party_name: '',
  process_rate: '', outbound_bill_no: '',
  checked_by: '', panchal_incoming_no: '',
};

// One line of the challan. Nothing pre-selected in the type, deliberately: a
// grade the user did not choose is worse than one they have to pick.
const newLine = () => ({
  key: Math.random().toString(36).slice(2),
  challan_type: '', sent_qty: '', received_dozens: '', sent_dozens: '',
});

const unitText = (dozen) => (dozen ? ' dozen' : 'm');
const sum = (xs) => Math.round(xs.reduce((s, x) => s + (Number(x) || 0), 0) * 100) / 100;

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
 * Send part of a lot somewhere: a later stage, the warehouse, or out of the
 * business to a buyer.
 *
 * ONE ACT, not two. Adding a challan is sending the lot on, so this records the
 * whole hand-over — what left, what came back and what the stage cost. There is
 * no in-transit state to fill in later.
 *
 * ONE CHALLAN, SEVERAL LINES. The header — destination, challan no, party, rate
 * and the hand-over fields — is said once. Below it, one line per grade sent
 * (a Fresh line and a Second line, say); each becomes its own lot at the
 * destination, because the grades travel separately from there. A total row
 * sits above the lines so the challan's whole is visible while it is typed.
 *
 * WHAT A LINE HOLDS depends on the lot it leaves:
 * - Out of PROCESSING, the last stage in metres, a line is Challan Type · Sent
 *   Qty (m) · Dozens Received · Metre per Dozen. This is where fabric becomes
 *   pieces.
 * - Out of any stage that already counts dozens, a line is Challan Type · Dozens
 *   Sent. What was sent IS what arrives — the dozens sent become the next lot's
 *   dozens received.
 *
 * THE RATE belongs to the stage the goods are LEAVING and is per dozen: raised
 * from the Processing tab it is the Processing rate. One rate per challan,
 * shared by its lines.
 *
 * EDIT MODE. Pass `challan` and this corrects one existing line. The header is
 * shared, so a header change is applied by the server to every line of the
 * challan; the line's own fields change on this line only. The destination is
 * not offered — moving a challan would relocate a live lot and everything
 * hanging off it. Withdraw and re-raise for that.
 *
 * CHECKED BY is asked at two destinations and nowhere else: arriving in OUR
 * warehouse, and leaving the business. Everywhere else the server stamps
 * whoever entered the row. Panchal also gets the warehouse's own incoming
 * number — the carried-down one tracks the material, PCL Inc No is what the
 * warehouse files it under.
 */
export default function ChallanModal({ lot, challan = null, onClose, onSaved }) {
  const isEdit = !!challan;
  const [form, setForm] = useState(EMPTY_HEADER);
  const [lines, setLines] = useState(() => [newLine()]);
  const [saving, setSaving] = useState(false);
  const [parties, setParties] = useState([]);
  const [partiesLoaded, setPartiesLoaded] = useState(false);
  const [checkers, setCheckers] = useState([]);
  // On an edit the destination is fixed — it is where the row already sits.
  const [target, setTarget] = useState(challan?.stage || nextStage(lot?.stage));

  const options = destinationsFor(lot?.stage);
  const sourceStage = lot?.stage;
  // Out of a lot that already counts dozens, lines are dozens only.
  const parentDozen = countsDozens(sourceStage);
  const unit = unitText(parentDozen);
  const isExit = target === EXIT_STAGE;
  const isStock = target === STOCK_STAGE;
  const needsChecker = isStock || isExit;
  const rateLabel = `${stageRateLabel(sourceStage)} (per dozen)`;

  // What this challan may draw on, in the parent's unit. On an edit the line's
  // own quantity is already counted in the parent's forwarded total, so add it
  // back — the same arithmetic the server's update() does.
  const ownSent = isEdit ? Number(parentDozen ? challan?.sent_dozens : challan?.sent_qty) || 0 : 0;
  const available = Math.round((Number(lot?.balance || 0) + ownSent) * 100) / 100;

  const sentOf = (l) => (parentDozen ? l.sent_dozens : l.sent_qty);
  const dozensOf = (l) => (parentDozen ? l.sent_dozens : l.received_dozens);
  const totalSent = sum(lines.map(sentOf));
  const totalDozens = sum(lines.map(dozensOf));
  const totalPerDozen = parentDozen ? null : metresPerDozen(totalSent || '', totalDozens || '');

  // Refetched whenever the destination changes, not once on mount: the list is
  // narrowed by where the goods are going, and the master can change under an
  // already-open tab anyway.
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

  // Fetched when the modal opens rather than once per page: the roster can
  // change under a tab that has been sitting open.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const users = await listUsersLite({ role: ROLES.WAREHOUSE_POC });
        if (!cancelled) setCheckers(users || []);
      } catch {
        if (!cancelled) toast.error('Could not load the Warehouse POC list');
      }
    })();
    return () => { cancelled = true; };
  }, [challan?.id]);

  // Prefill once per challan line being edited.
  useEffect(() => {
    if (!challan) return;
    setForm({
      challan_no: challan.challan_no ?? '',
      party_name: challan.party_name ?? '',
      process_rate: challan.process_rate ?? '',
      outbound_bill_no: challan.outbound_bill_no ?? '',
      checked_by: challan.checked_by ?? '',
      panchal_incoming_no: challan.panchal_incoming_no ?? '',
    });
    setLines([{
      ...newLine(),
      challan_type: challan.challan_type ?? '',
      sent_qty: challan.sent_qty ?? '',
      received_dozens: challan.received_dozens ?? '',
      sent_dozens: challan.sent_dozens ?? '',
    }]);
    setTarget(challan.stage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [challan?.id]);

  const setField = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const setLine = (key, patch) => setLines(ls => ls.map(l => (l.key === key ? { ...l, ...patch } : l)));
  const addLine = () => setLines(ls => [...ls, newLine()]);
  const removeLine = (key) => setLines(ls => (ls.length > 1 ? ls.filter(l => l.key !== key) : ls));

  // Twin of lineFieldsError on the server, message for message and in the same
  // order: type, then quantity.
  const lineError = (l, prefix) => {
    if (!l.challan_type) return `${prefix}Challan Type is required`;
    if (parentDozen) {
      const err = qtyError(l.sent_dozens, 'Dozens Sent');
      return err ? `${prefix}${err}` : null;
    }
    const sentErr = qtyError(l.sent_qty, 'Sent Qty');
    if (sentErr) return `${prefix}${sentErr}`;
    const dzErr = qtyError(l.received_dozens, 'Dozens Received');
    return dzErr ? `${prefix}${dzErr}` : null;
  };

  // Mirrors the server's rules AND their order, which is the form's order:
  // party and challan no, then each line, then the rest of the header, then the
  // balance -- so the message shown here is the one the server would return.
  const fieldError = () => {
    if (!String(form.party_name || '').trim()) return 'Party Name is required';
    if (!String(form.challan_no || '').trim()) return 'Challan No is required';
    const challanErr = challanError(form.challan_no);
    if (challanErr) return challanErr;
    for (let i = 0; i < lines.length; i += 1) {
      const err = lineError(lines[i], lines.length > 1 ? `Line ${i + 1}: ` : '');
      if (err) return err;
    }
    const rateErr = moneyError(form.process_rate, stageRateLabel(sourceStage));
    if (rateErr) return rateErr;
    if (needsChecker && !form.checked_by) return 'Checked By is required';
    if (isExit && !String(form.outbound_bill_no || '').trim()) {
      return 'Outbound Bill No is required when sending to a third party';
    }
    if (isStock && !String(form.panchal_incoming_no || '').trim()) {
      return 'PCL Inc No is required when sending to Panchal';
    }
    if (totalSent - available > EPSILON) {
      return `Cannot send ${totalSent}${unit} — only ${available}${unit} is left on this lot`;
    }
    return null;
  };

  const linePayload = (l) => (parentDozen
    ? { challan_type: l.challan_type, sent_dozens: Number(l.sent_dozens) }
    // received_qty is deliberately NOT sent. The server defaults it to
    // sent_qty, and letting it do so keeps one rule rather than two.
    : { challan_type: l.challan_type, sent_qty: Number(l.sent_qty), received_dozens: Number(l.received_dozens) });

  const submit = async (e) => {
    e.preventDefault();
    const err = fieldError();
    if (err) { toast.error(err); return; }
    setSaving(true);
    const header = {
      challan_no: form.challan_no.trim(),
      party_name: form.party_name.trim(),
      process_rate: form.process_rate === '' ? null : Number(form.process_rate),
      outbound_bill_no: isExit ? form.outbound_bill_no.trim() : null,
      panchal_incoming_no: isStock ? form.panchal_incoming_no.trim() : null,
      // Omitted, not nulled, everywhere else: an absent key is what tells the
      // server to stamp the session user.
      ...(needsChecker ? { checked_by: Number(form.checked_by) } : {}),
    };
    try {
      if (isEdit) {
        // One line, flat: no parent and no target stage — an edit corrects this
        // row where it stands. Header fields reach its sibling lines server-side.
        await updateStitchingLot(challan.id, { ...header, ...linePayload(lines[0]) });
        toast.success(`Challan ${header.challan_no} updated`);
      } else {
        await addStitchingChallan({
          parent_src: lot.src, parent_id: lot.id, target_stage: target,
          ...header, lines: lines.map(linePayload),
        });
        const what = `${totalSent}${unit}${lines.length > 1 ? ` on ${lines.length} lines` : ''}`;
        toast.success(isExit ? `Sold ${what} to ${header.party_name}` : `Sent ${what} to ${target}`);
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

  return (
    <Modal isOpen onClose={onClose} title={isEdit ? 'Edit Challan Line' : 'Add Challan'} size="xl">
      <form onSubmit={submit} className="space-y-4">
        <div className="rounded-lg bg-gray-50 border border-gray-200 px-4 py-3 text-sm">
          <div className="font-medium text-[#003049]">
            {lot.item_name}{lot.variant ? ` — ${lot.variant}` : ''}
          </div>
          <div className="text-gray-500 text-xs mt-0.5">
            {lot.stage} · {lot.vendor_name || lot.party_name} · PO {lot.po_order_no}
            {lot.incoming_prefix || lot.incoming_no
              ? ` · ${lot.incoming_prefix || ''}${lot.incoming_no || ''}` : ''}
          </div>
          <div className="text-gray-600 text-xs mt-1">
            Available <span className="font-semibold text-[#003049]">{fmtNum(available)}{unit}</span>
            {' · PO Qty '}{fmtNum(lot.po_qty_metres)}m
            {lot.metres_per_dozen != null && ` · ${fmtNum(lot.metres_per_dozen)} m/dozen`}
          </div>
        </div>

        {/* ONE decision, made first, with the real destinations named. */}
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
              Challan No, Party, rate and the hand-over fields apply to every line of the challan.
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

          {/* A dropdown, not free text, already narrowed to parties tagged for
              this destination. */}
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

        </div>

        {/* LINE ITEMS — one row per grade sent. The total sits on top, so the
            challan's whole is read before its parts. */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className={labelCls}>
              Line Items <span className="text-red-500">*</span>
            </label>
            {!isEdit && (
              <button
                type="button"
                onClick={addLine}
                className="inline-flex items-center gap-1 text-xs text-[#c1121f] hover:underline"
              >
                <Plus size={12} />Add line
              </button>
            )}
          </div>
          <div className="overflow-x-auto border border-gray-200 rounded-lg">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500">
                <tr>
                  <th className="px-2 py-2 text-left font-medium w-8">#</th>
                  <th className="px-2 py-2 text-left font-medium">Challan Type</th>
                  {parentDozen ? (
                    <th className="px-2 py-2 text-left font-medium">Dozens Sent</th>
                  ) : (
                    <>
                      <th className="px-2 py-2 text-left font-medium">Sent Qty (m)</th>
                      <th className="px-2 py-2 text-left font-medium">Dozens Received</th>
                      <th className="px-2 py-2 text-left font-medium">Metre per Dozen</th>
                    </>
                  )}
                  <th className="px-2 py-2 w-8" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                <tr className="bg-[#fdf0d5]/40 text-xs font-semibold text-[#003049]">
                  <td className="px-2 py-2" />
                  <td className="px-2 py-2">
                    Total{lines.length > 1 ? ` · ${lines.length} lines` : ''}
                  </td>
                  {parentDozen ? (
                    <td className="px-2 py-2">{fmtNum(totalDozens)} dozen of {fmtNum(available)}</td>
                  ) : (
                    <>
                      <td className="px-2 py-2">{fmtNum(totalSent)}m of {fmtNum(available)}m</td>
                      <td className="px-2 py-2">{fmtNum(totalDozens)} dozen</td>
                      <td className="px-2 py-2">{totalPerDozen == null ? '—' : fmtNum(totalPerDozen)}</td>
                    </>
                  )}
                  <td />
                </tr>
                {lines.map((l, i) => {
                  const perDozen = parentDozen ? null : metresPerDozen(l.sent_qty, l.received_dozens);
                  return (
                    <tr key={l.key}>
                      <td className="px-2 py-1.5 text-gray-400 text-xs">{i + 1}</td>
                      <td className="px-2 py-1.5">
                        <select
                          value={l.challan_type}
                          onChange={e => setLine(l.key, { challan_type: e.target.value })}
                          className={cellInputCls}
                        >
                          <option value="">Select...</option>
                          {CHALLAN_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                        </select>
                      </td>
                      {parentDozen ? (
                        <td className="px-2 py-1.5">
                          <input
                            type="number" min={0.01} step="0.01"
                            value={l.sent_dozens}
                            onChange={e => setLine(l.key, { sent_dozens: e.target.value })}
                            className={cellInputCls}
                          />
                        </td>
                      ) : (
                        <>
                          <td className="px-2 py-1.5">
                            <input
                              type="number" min={0.01} step="0.01"
                              value={l.sent_qty}
                              onChange={e => setLine(l.key, { sent_qty: e.target.value })}
                              className={cellInputCls}
                            />
                          </td>
                          <td className="px-2 py-1.5">
                            <input
                              type="number" min={0.01} step="0.01"
                              value={l.received_dozens}
                              onChange={e => setLine(l.key, { received_dozens: e.target.value })}
                              className={cellInputCls}
                            />
                          </td>
                          <td className="px-2 py-1.5">
                            {/* The yield of this line alone — metres sent over
                                the dozens they came back as. Worked out, never
                                typed. */}
                            <input
                              value={perDozen == null ? '' : fmtNum(perDozen)}
                              disabled
                              className={`${cellInputCls} bg-gray-50 text-gray-500`}
                            />
                          </td>
                        </>
                      )}
                      <td className="px-2 py-1.5 text-right">
                        {!isEdit && lines.length > 1 && (
                          <button
                            type="button"
                            onClick={() => removeLine(l.key)}
                            title="Remove this line"
                            className="p-1 rounded hover:bg-red-50 text-red-500"
                          >
                            <X size={14} />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-1 text-[11px] text-gray-400">
            {parentDozen
              ? `From ${sourceStage} on the goods are counted in dozens: the dozens sent are what the next stage receives.`
              : 'Each line becomes its own lot at the destination. Metre per Dozen is the metres sent divided by the dozens that came back.'}
          </p>
        </div>

        {/* The rest of the header, set off by a light rule: what the stage
            cost, and the hand-over fields a warehouse or a sale asks for. */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 border-t border-gray-100 pt-4">
          {/* Named for the stage the goods are LEAVING: the work that was just
              done is what is being paid for. Per dozen, like every challan rate
              now, and one rate for the whole challan. */}
          <Field
            label={rateLabel}
            hint={`What ${sourceStage?.toLowerCase()} cost per dozen for the goods on this challan`}
          >
            <input
              type="number" min={0} step="0.01"
              value={form.process_rate}
              onChange={e => setField('process_rate', e.target.value)}
              className={inputCls}
            />
          </Field>

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

          {isStock && (
            <Field label="PCL Inc No" required hint="Panchal's incoming number for this lot">
              <input
                value={form.panchal_incoming_no}
                onChange={e => setField('panchal_incoming_no', e.target.value)}
                className={inputCls}
                maxLength={50}
                placeholder="e.g. 4471"
              />
            </Field>
          )}

          {needsChecker && (
            <Field
              label="Checked By"
              required
              hint={isExit ? 'Who checked the goods out' : 'Who received the goods at Panchal'}
            >
              <select
                value={form.checked_by || ''}
                onChange={e => setField('checked_by', e.target.value)}
                className={inputCls}
              >
                <option value="">Select...</option>
                {checkerOptionsFor(checkers, challan?.checked_by, challan?.checked_by_name).map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </Field>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={saving}>{isEdit ? 'Save' : 'Send'}</Button>
        </div>
      </form>
    </Modal>
  );
}
