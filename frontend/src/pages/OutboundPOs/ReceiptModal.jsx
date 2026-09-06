import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import Modal from '../../components/ui/Modal';
import Button from '../../components/ui/Button';
import { listUsersLite } from '../../api/users.api';
import { addOutboundPOLineReceipt, updateOutboundPOLineReceipt } from '../../api/outboundPOs.api';
import { ROLES } from '../../utils/roles';
import { fmtNum } from '../../utils/stitching';
import {
  EMPTY_RECEIPT, INCOMING_NO_MAX,
  receiptFieldError, withDerivedAfterRate, stageOptionsFor, checkerOptionsFor,
  isFabricLine, outstandingOf, qtyDifference, offeredQtyDiffAction,
} from './receiptFields';

const inputBase = 'px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f]';
const inputCls = `w-full ${inputBase}`;
const labelCls = 'block text-xs font-medium text-gray-600 mb-1';

function Field({ label, required, children, hint, className = '' }) {
  return (
    <div className={className}>
      <label className={labelCls}>
        {label}{required && <span className="text-red-500"> *</span>}
      </label>
      {children}
      {hint && <p className="mt-1 text-[11px] text-gray-400">{hint}</p>}
    </div>
  );
}

/**
 * What this delivery is over or under by, and what is being done about it.
 *
 * Measured against what was still OUTSTANDING when the delivery was entered, not
 * against the whole order — a part delivery is not a shortfall.
 *
 * Exactly one box is ever offered: you cannot write off a surplus or roll over a
 * shortfall, and a delivery that matches has nothing to explain. Ticking one
 * demands a reason, which is the whole point of recording it.
 *
 * DECIDED ONCE, on the delivery that raised it. An edit shows what was recorded
 * and does not re-open it — unwinding a write-off the line's Short has already
 * absorbed is what the Short cell on the line is for.
 */
function QtyDifference({ form, setField, line, isAdd }) {
  const outstanding = outstandingOf(line);
  const difference = qtyDifference(form.received_qty, line);
  const offered = offeredQtyDiffAction(difference);
  const unit = line.unit_metric ? ` ${line.unit_metric}` : '';

  if (!isAdd) {
    if (!form.qty_diff_action) return null;
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50/60 px-4 py-3 text-sm">
        <span className="font-medium text-amber-800">
          {form.qty_diff_action === 'write_off' ? 'Written off' : 'Rolled over'}
        </span>
        <span className="text-gray-600"> when this receipt was entered — {form.qty_diff_reason}</span>
        <p className="mt-1 text-[11px] text-gray-500">
          Change the line&apos;s Short to correct it.
        </p>
      </div>
    );
  }

  const toggle = (action) => setField(
    'qty_diff_action', form.qty_diff_action === action ? '' : action,
  );

  return (
    <div className="rounded-lg border border-gray-200 px-4 py-3">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <span className={labelCls}>Qty difference</span>
        <span className={`text-sm font-semibold ${
          difference == null || Math.abs(difference) < 0.005 ? 'text-gray-400'
            : difference < 0 ? 'text-amber-700' : 'text-[#003049]'
        }`}
        >
          {difference == null ? '—' : `${difference > 0 ? '+' : ''}${fmtNum(difference)}${unit}`}
        </span>
      </div>
      <p className="mt-0.5 text-[11px] text-gray-400">
        Against {fmtNum(outstanding)}{unit} still outstanding on this line
      </p>

      <div className="mt-3 flex flex-wrap gap-4">
        {[
          ['write_off', 'Write off', 'The shortfall is never coming — closes the line'],
          ['rollover', 'Rollover', 'Accept the excess'],
        ].map(([action, label, hint]) => (
          <label
            key={action}
            className={`flex items-start gap-2 text-sm ${
              offered === action ? 'text-[#003049]' : 'text-gray-300 cursor-not-allowed'
            }`}
          >
            <input
              type="checkbox"
              disabled={offered !== action}
              checked={form.qty_diff_action === action}
              onChange={() => toggle(action)}
              className="mt-0.5 accent-[#c1121f]"
            />
            <span>
              {label}
              {offered === action && <span className="block text-[11px] text-gray-400">{hint}</span>}
            </span>
          </label>
        ))}
      </div>

      {form.qty_diff_action && (
        <div className="mt-3">
          <label className={labelCls}>
            Reason<span className="text-red-500"> *</span>
          </label>
          <textarea
            rows={2}
            value={form.qty_diff_reason}
            onChange={e => setField('qty_diff_reason', e.target.value)}
            className={inputCls}
            maxLength={300}
            placeholder={form.qty_diff_action === 'write_off'
              ? 'e.g. mill cannot supply the balance'
              : 'e.g. mill sent a full taga'}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Add or edit one receipt against a PO line.
 *
 * Replaces the old inline row: eleven inputs across a table row was what pushed
 * the PO detail grid past the width it had, and a form gives each field a label
 * and room to breathe. `receipt` null means add mode.
 */
export default function ReceiptModal({ poId, line, receipt, onClose, onSaved }) {
  const isAdd = !receipt;
  const [form, setForm] = useState(EMPTY_RECEIPT);
  const [saving, setSaving] = useState(false);
  const [checkers, setCheckers] = useState([]);

  // Only fabric has a stage and a metres figure. Everything else on an outbound
  // PO is received and done with -- it travels no stage chain.
  const fabric = isFabricLine(line);

  // A receipt that never had a bill number (migration 053 synthesized those from
  // the legacy flat `received` value) stays editable without inventing one —
  // matching what the server enforces.
  const hadBillNo = !isAdd && !!String(receipt.bill_no ?? '').trim();

  useEffect(() => {
    setForm(isAdd ? EMPTY_RECEIPT : {
      received_qty: receipt.received_qty ?? '',
      received_rate: receipt.received_rate ?? '',
      bill_no: receipt.bill_no ?? '',
      incoming_no: receipt.incoming_no ?? '',
      checked_by: receipt.checked_by ?? '',
      process_rate: receipt.process_rate ?? '',
      after_rate: receipt.after_rate ?? '',
      incoming_stage: receipt.incoming_stage ?? '',
      qty_in_metres: receipt.qty_in_metres ?? '',
      // Recorded once, when the delivery was entered. Shown on an edit, never
      // re-decided there -- corrections go through the line's Short cell.
      qty_diff_action: receipt.qty_diff_action ?? '',
      qty_diff_reason: receipt.qty_diff_reason ?? '',
    });
  }, [receipt, isAdd]);

  // Options are fetched every time the modal opens rather than once on page
  // mount: the prefix master and the Warehouse_POC list can change under an
  // already-open tab, and the server validates against the live rows.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const users = await listUsersLite({ role: ROLES.WAREHOUSE_POC });
        if (cancelled) return;
        setCheckers(users || []);
      } catch {
        if (!cancelled) toast.error('Could not load the form options');
      }
    })();
    return () => { cancelled = true; };
  }, [receipt?.id, isAdd]);

  const setField = (field, value) => setForm(f => withDerivedAfterRate(f, field, value));

  const submit = async (e) => {
    e.preventDefault();
    const err = receiptFieldError(form, { requireBillNo: isAdd || hadBillNo, line });
    if (err) { toast.error(err); return; }
    setSaving(true);
    try {
      const billNo = String(form.bill_no ?? '').trim();
      const payload = {
        received_qty: Number(form.received_qty),
        received_rate: Number(form.received_rate),
        checked_by: Number(form.checked_by),
        incoming_no: String(form.incoming_no ?? '').trim() || null,
        process_rate: form.process_rate === '' ? null : Number(form.process_rate),
        after_rate: form.after_rate === '' ? null : Number(form.after_rate),
      };
      if (fabric) {
        payload.incoming_stage = form.incoming_stage || null;
        payload.qty_in_metres = form.qty_in_metres === '' ? null : Number(form.qty_in_metres);
      }
      // Only ever decided on the delivery that raised the difference.
      if (isAdd && form.qty_diff_action) {
        payload.qty_diff_action = form.qty_diff_action;
        payload.qty_diff_reason = form.qty_diff_reason.trim();
      }
      if (isAdd) {
        payload.bill_no = billNo || null;
        await addOutboundPOLineReceipt(poId, line.id, payload);
        toast.success('Receipt added');
      } else {
        // Omit bill_no entirely for a receipt that never had one, rather than
        // sending an explicit null. The server validates only the fields
        // actually present, so a null would count as touching it and trip the
        // mandatory rule on an edit that has nothing to do with the bill number.
        if (billNo || hadBillNo) payload.bill_no = billNo || null;
        await updateOutboundPOLineReceipt(poId, line.id, receipt.id, payload);
        toast.success('Receipt updated');
      }
      onSaved();
    } catch (err2) {
      toast.error(err2.response?.data?.message || (isAdd ? 'Failed to add receipt' : 'Failed to update receipt'));
    } finally {
      setSaving(false);
    }
  };

  const articleLabel = `${line.category} · ${line.item_name}${line.variant ? ` · ${line.variant}` : ''}`;

  return (
    <Modal isOpen onClose={onClose} title={isAdd ? 'Add Receipt' : 'Edit Receipt'} size="lg">
      <form onSubmit={submit} className="space-y-4">
        <div className="rounded-lg bg-gray-50 border border-gray-200 px-4 py-3 text-sm">
          <div className="font-medium text-[#003049]">{articleLabel}</div>
          <div className="text-gray-500 text-xs mt-0.5">
            Ordered {line.qty}{line.unit_metric ? ` ${line.unit_metric}` : ''} @ {line.rate}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field
            label="Received Qty"
            required
            hint={line.unit_metric ? `In ${line.unit_metric}, as ordered` : undefined}
          >
            <input
              type="number" min={0.01} step="0.01"
              value={form.received_qty}
              onChange={e => setField('received_qty', e.target.value)}
              className={inputCls}
              required
              autoFocus
            />
          </Field>

          {/* Fabric is bought in taga and worked in metres, and no factor
              converts the two — the user counts and enters it. Next to Received
              Qty because they describe the same delivery. */}
          {fabric && (
            <Field
              label="Qty in metres"
              required
              hint="What the Stitching page counts — work it out and enter it"
            >
              <input
                type="number" min={0.01} step="0.01"
                value={form.qty_in_metres}
                onChange={e => setField('qty_in_metres', e.target.value)}
                className={inputCls}
              />
            </Field>
          )}

          <Field label="Received Rate" required hint={`Agreed rate on the line is ${line.rate}`}>
            <input
              type="number" min={0} step="0.01"
              value={form.received_rate}
              onChange={e => setField('received_rate', e.target.value)}
              className={inputCls}
              required
            />
          </Field>

          <Field label="Process Rate" hint="Cost of processing up to the stage received at">
            <input
              type="number" min={0} step="0.01"
              value={form.process_rate}
              onChange={e => setField('process_rate', e.target.value)}
              className={inputCls}
            />
          </Field>

          <Field label="After Rate" hint="Defaults to Received + Process — type over it to pin a value">
            <input
              type="number" min={0} step="0.01"
              value={form.after_rate}
              onChange={e => setField('after_rate', e.target.value)}
              className={inputCls}
            />
          </Field>

          <Field label="Bill No" required={isAdd || hadBillNo}>
            <input
              value={form.bill_no}
              onChange={e => setField('bill_no', e.target.value)}
              className={inputCls}
              maxLength={INCOMING_NO_MAX}
            />
          </Field>

          <Field label="Checked By" required>
            <select
              value={form.checked_by || ''}
              onChange={e => setField('checked_by', e.target.value)}
              className={inputCls}
              required
            >
              <option value="">Select...</option>
              {checkerOptionsFor(checkers, receipt?.checked_by, receipt?.checked_by_name).map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </Field>

          {/* Full width: two controls in one field, and squeezing them into half
              the grid left the number box too small to read. On anything that is
              not fabric there is no stage at all, so it is one plain input. */}
          <Field
            label="Incoming No"
            required={fabric}
            hint={fabric
              ? 'The stage records where these goods arrived — the code that prints on it follows from it'
              : 'Free text — the gate register reference'}
            className="sm:col-span-2"
          >
            <div className="flex gap-2">
              {fabric && (
                <select
                  value={form.incoming_stage || ''}
                  onChange={e => setField('incoming_stage', e.target.value)}
                  className={`${inputBase} w-40 shrink-0`}
                >
                  <option value="">Stage…</option>
                  {stageOptionsFor().map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              )}
              <input
                value={form.incoming_no}
                onChange={e => setField('incoming_no', e.target.value)}
                className={`${inputBase} flex-1 min-w-0`}
                maxLength={INCOMING_NO_MAX}
                placeholder="e.g. 0077"
              />
            </div>
          </Field>
        </div>

        <QtyDifference
          form={form}
          setField={setField}
          line={line}
          isAdd={isAdd}
        />

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={saving}>{isAdd ? 'Add Receipt' : 'Save Receipt'}</Button>
        </div>
      </form>
    </Modal>
  );
}
