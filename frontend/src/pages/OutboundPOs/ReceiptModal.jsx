import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import Modal from '../../components/ui/Modal';
import Button from '../../components/ui/Button';
import { listUsersLite } from '../../api/users.api';
import { listStitchingPrefixes } from '../../api/stitchingPrefixes.api';
import { addOutboundPOLineReceipt, updateOutboundPOLineReceipt } from '../../api/outboundPOs.api';
import { ROLES } from '../../utils/roles';
import {
  EMPTY_RECEIPT, INCOMING_NO_MAX,
  receiptFieldError, withDerivedAfterRate, prefixGroupsFor, checkerOptionsFor,
} from './receiptFields';

const inputBase = 'px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f]';
const inputCls = `w-full ${inputBase}`;
const labelCls = 'block text-xs font-medium text-gray-600 mb-1';

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
  const [prefixes, setPrefixes] = useState([]);

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
      challan_no: receipt.challan_no ?? '',
      incoming_prefix_id: receipt.incoming_prefix_id ?? '',
    });
  }, [receipt, isAdd]);

  // Options are fetched every time the modal opens rather than once on page
  // mount: the prefix master and the Warehouse_POC list can change under an
  // already-open tab, and the server validates against the live rows.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [users, pfx] = await Promise.all([
          listUsersLite({ role: ROLES.WAREHOUSE_POC }),
          listStitchingPrefixes(),
        ]);
        if (cancelled) return;
        setCheckers(users || []);
        setPrefixes(pfx || []);
      } catch {
        if (!cancelled) toast.error('Could not load the form options');
      }
    })();
    return () => { cancelled = true; };
  }, [receipt?.id, isAdd]);

  const setField = (field, value) => setForm(f => withDerivedAfterRate(f, field, value));

  const submit = async (e) => {
    e.preventDefault();
    const err = receiptFieldError(form, { requireBillNo: isAdd || hadBillNo });
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
        challan_no: String(form.challan_no ?? '').trim() || null,
        incoming_prefix_id: form.incoming_prefix_id || null,
      };
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
          <Field label="Received Qty" required>
            <input
              type="number" min={0.01} step="0.01"
              value={form.received_qty}
              onChange={e => setField('received_qty', e.target.value)}
              className={inputCls}
              required
              autoFocus
            />
          </Field>

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

          <Field label="Challan No">
            <input
              value={form.challan_no}
              onChange={e => setField('challan_no', e.target.value)}
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

          <Field label="Incoming No" hint="The prefix records the stage these goods arrived at">
            <div className="flex gap-2">
              <select
                value={form.incoming_prefix_id || ''}
                onChange={e => setField('incoming_prefix_id', e.target.value)}
                className={`${inputBase} w-24 shrink-0`}
              >
                <option value="">—</option>
                {prefixGroupsFor(prefixes, receipt?.incoming_prefix_id, receipt?.incoming_prefix).map(g => (
                  <optgroup key={g.stage} label={g.stage}>
                    {g.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </optgroup>
                ))}
              </select>
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

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={saving}>{isAdd ? 'Add Receipt' : 'Save Receipt'}</Button>
        </div>
      </form>
    </Modal>
  );
}
