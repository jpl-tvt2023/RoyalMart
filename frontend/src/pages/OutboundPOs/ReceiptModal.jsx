import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import Modal from '../../components/ui/Modal';
import Button from '../../components/ui/Button';
import { addOutboundPOLineReceipt, updateOutboundPOLineReceipt } from '../../api/outboundPOs.api';
import { listUsersLite } from '../../api/users.api';
import { ROLES } from '../../utils/roles';
import { sortByText } from '../../utils/sort';
import { checkerOptionsFor } from '../../utils/checkers';
import { fmtNum, STOCK_STAGE, EXIT_STAGE, READYMADE, umKind, receiptStageBlockReason } from '../../utils/stitching';
import {
  EMPTY_RECEIPT, INCOMING_NO_MAX, NOTE_MAX,
  receiptFieldError, withDerivedAfterRate, stageOptionsFor, defaultReceiptStage,
  isStitchingLine, lineType, receiptUmKind, receiptTakesMetres,
  receiptDozensDerivable, receiptSettledDozens, receiptIsSale,
  outstandingOf, qtyDifference, offeredQtyDiffAction,
  receiptCountsDozens, metresPerDozen,
  receiptIsGraded, receiptGradeTotal, GRADE_FIELDS,
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
export default function ReceiptModal({ poId, line, receipt, metricOptions = [], onClose, onSaved }) {
  const isAdd = !receipt;
  const [form, setForm] = useState(EMPTY_RECEIPT);
  const [saving, setSaving] = useState(false);
  // Warehouse POCs, for the one stage that asks who checked the goods over.
  const [checkers, setCheckers] = useState([]);

  // Only Fabric and Readymade travel the Stitching stages, so only they have a
  // stage. Everything else on an outbound PO is received and done with.
  const stitching = isStitchingLine(line);
  const type = lineType(line);
  // What the delivery's unit means (umKind): a UM in dozens IS the dozen count,
  // one in metres IS the metres, and Readymade by the piece is twelve to the
  // dozen -- so the form asks only for what the UM does not already say.
  const kind = receiptUmKind(form, line);
  const stage = form.incoming_stage;
  const stageOptions = stageOptionsFor(line, kind);
  // Pieces to count from Stitching on; graded from Packing on; a sale at Third
  // Party. The stage is the form's first field, so all of this follows it.
  const dozens = receiptCountsDozens(line, stage);
  const graded = receiptIsGraded(line, stage);
  const sale = receiptIsSale(line, stage);
  const takesMetres = receiptTakesMetres(line, kind);
  const metresFromQty = takesMetres && kind === 'metre';
  const dozensDerivable = receiptDozensDerivable(line, kind, stage);
  const settled = receiptSettledDozens(form, line, kind);
  const gradeTotal = receiptGradeTotal(form);
  const metres = metresFromQty ? form.received_qty : form.qty_in_metres;
  const dozenCount = graded ? (gradeTotal || '') : dozensDerivable ? (settled ?? '') : form.received_dozens;
  const perDozen = takesMetres ? metresPerDozen(metres, dozenCount) : null;
  const umLabel = form.unit_metric || line.unit_metric || '';
  const processingBlocked = stitching ? receiptStageBlockReason('Processing', { type, kind }) : null;

  // A receipt that never had a bill number (migration 053 synthesized those from
  // the legacy flat `received` value) stays editable without inventing one —
  // matching what the server enforces.
  const hadBillNo = !isAdd && !!String(receipt.bill_no ?? '').trim();

  useEffect(() => {
    setForm(isAdd ? {
      ...EMPTY_RECEIPT,
      unit_metric: line.unit_metric || '',
      // The first stage this delivery may take: Processing for fabric that has
      // metres, Stitching for Readymade and anything bought in dozens.
      incoming_stage: stitching ? defaultReceiptStage(line, umKind(line.unit_metric)) : '',
    } : {
      received_qty: receipt.received_qty ?? '',
      // A receipt taken before migration 084 has none of its own, so it shows
      // the line's -- which is the unit it was counted in, just never recorded.
      unit_metric: receipt.unit_metric || line.unit_metric || '',
      received_rate: receipt.received_rate ?? '',
      bill_no: receipt.bill_no ?? '',
      incoming_no: receipt.incoming_no ?? '',
      process_rate: receipt.process_rate ?? '',
      after_rate: receipt.after_rate ?? '',
      incoming_stage: receipt.incoming_stage ?? '',
      qty_in_metres: receipt.qty_in_metres ?? '',
      // Omitted here once, which made every dozen-stage receipt uneditable: the
      // field rendered blank, validation demanded a count, and the real value
      // sat in the database with no way to retype it.
      received_dozens: receipt.received_dozens ?? '',
      // Recorded once, when the delivery was entered. Shown on an edit, never
      // re-decided there -- corrections go through the line's Short cell.
      qty_diff_action: receipt.qty_diff_action ?? '',
      qty_diff_reason: receipt.qty_diff_reason ?? '',
      // A receipt at Packing or Panchal taken before migration 089 has none,
      // and shows 0s to fill in -- the save asks for them.
      fresh_dozens: String(receipt.fresh_dozens ?? 0),
      second_dozens: String(receipt.second_dozens ?? 0),
      third_dozens: String(receipt.third_dozens ?? 0),
      note: receipt.note ?? '',
      // A sale's hand-over. Checked By is only a question at Third Party -- on
      // every other receipt it is whoever entered it -- so it is only carried
      // into the form for a receipt already there.
      outbound_bill_no: receipt.outbound_bill_no ?? '',
      checked_by: receipt.incoming_stage === EXIT_STAGE ? (receipt.checked_by ?? '') : '',
    });
  // Primitives, not the line object: the page may hand over a fresh object on
  // any render, and resetting on identity would wipe what the user is typing.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt, isAdd, line.unit_metric, type]);

  // The Checked By list is only needed for a sale, but it is small and the
  // stage can change under the user, so it is fetched once with the form.
  useEffect(() => {
    if (!stitching) return;
    listUsersLite({ role: ROLES.WAREHOUSE_POC })
      .then(users => setCheckers(sortByText(users || [], u => u.name)))
      .catch(() => setCheckers([]));
  }, [stitching]);

  const setField = (field, value) => setForm((f) => {
    const next = withDerivedAfterRate(f, field, value);
    // A unit that cannot take the stage already picked -- Processing, for a UM
    // in dozens -- moves the stage to the first one it can take.
    if (field === 'unit_metric' && stitching && next.incoming_stage
        && receiptStageBlockReason(next.incoming_stage, { type, kind: umKind(value || line.unit_metric) })) {
      next.incoming_stage = defaultReceiptStage(line, umKind(value || line.unit_metric));
    }
    return next;
  });

  const submit = async (e) => {
    e.preventDefault();
    const err = receiptFieldError(form, { requireBillNo: isAdd || hadBillNo, line });
    if (err) { toast.error(err); return; }
    setSaving(true);
    try {
      const billNo = String(form.bill_no ?? '').trim();
      const payload = {
        received_qty: Number(form.received_qty),
        unit_metric: form.unit_metric || null,
        received_rate: Number(form.received_rate),
        incoming_no: String(form.incoming_no ?? '').trim() || null,
        process_rate: form.process_rate === '' ? null : Number(form.process_rate),
        after_rate: form.after_rate === '' ? null : Number(form.after_rate),
        note: String(form.note ?? '').trim() || null,
      };
      if (stitching) {
        payload.incoming_stage = form.incoming_stage || null;
        // Sent only when typed: a UM in metres is copied across by the server,
        // and Readymade or goods bought in dozens carry none.
        payload.qty_in_metres = takesMetres && !metresFromQty && form.qty_in_metres !== ''
          ? Number(form.qty_in_metres) : null;
        if (graded) {
          for (const [, col] of GRADE_FIELDS) payload[col] = Number(form[col]) || 0;
          payload.received_dozens = gradeTotal;
        } else {
          // A UM-settled count is written by the server; only a typed one is sent.
          payload.received_dozens = dozens && !dozensDerivable && form.received_dozens !== ''
            ? Number(form.received_dozens) : null;
        }
        if (sale) {
          payload.incoming_no = null;
          payload.outbound_bill_no = String(form.outbound_bill_no ?? '').trim();
          payload.checked_by = Number(form.checked_by);
        }
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

  // What the stage hint says. Panchal and Third Party end the chain in two
  // different ways, and a disabled Processing says why.
  const stageHint = stage === STOCK_STAGE
    ? `Goods received straight into ${STOCK_STAGE} are the end of the chain — this receipt will be recorded as Closed`
    : sale
      ? 'Sold straight on to a buyer — no incoming number; our outbound bill and a Warehouse POC instead'
      : processingBlocked
        ? `Processing is not available: ${processingBlocked.split(' — ')[0].toLowerCase()}`
        : 'Where these goods arrived — the fields below follow from it';

  return (
    <Modal isOpen onClose={onClose} title={isAdd ? 'Add Receipt' : 'Edit Receipt'} size="lg">
      <form onSubmit={submit} className="space-y-4">
        <div className="rounded-lg bg-gray-50 border border-gray-200 px-4 py-3 text-sm">
          <div className="font-medium text-[#003049]">
            {articleLabel}
            {stitching && (
              <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-[#003049]/10 text-[#003049] align-middle">
                {type}
              </span>
            )}
          </div>
          <div className="text-gray-500 text-xs mt-0.5">
            Ordered {line.qty}{line.unit_metric ? ` ${line.unit_metric}` : ''} @ {line.rate}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {/* THE STAGE, first: everything below -- metres, dozens, grades, the
              Third Party hand-over -- reshapes to it, so it is answered before
              anything is typed. Processing is shown disabled, not hidden, for
              goods that have no metres, and the hint says why. */}
          {stitching && (
            <Field label="Stage" required hint={stageHint} className="sm:col-span-2">
              <select
                value={stage || ''}
                onChange={e => setField('incoming_stage', e.target.value)}
                className={inputCls}
              >
                <option value="">Stage…</option>
                {stageOptions.map(o => (
                  <option key={o.value} value={o.value} disabled={o.disabled}>
                    {o.label}{o.disabled ? ' (not available)' : ''}
                  </option>
                ))}
              </select>
            </Field>
          )}

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

          {/* The unit the quantity above is in, recorded on the receipt rather
              than inferred from the line. Pre-filled with the line's own, which
              is the answer on almost every delivery — the field exists so the
              row can say what it means without reaching back to the line, and so
              a later edit to the line cannot reinterpret a past delivery.

              A select, never free text: the options are what the Outbound
              Product List publishes for this article, which is the same set the
              server accepts. An article listed under one metric has nothing to
              choose, so it shows the value plainly instead of a one-item menu. */}
          <Field
            label="UM"
            required
            hint={metricOptions.length > 1
              ? 'The unit this delivery was counted in'
              : 'From the line — this article is listed in one unit'}
          >
            {metricOptions.length > 1 ? (
              <select
                value={form.unit_metric || ''}
                onChange={e => setField('unit_metric', e.target.value)}
                className={inputCls}
                required
              >
                <option value="">Select...</option>
                {metricOptions.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            ) : (
              <input
                value={form.unit_metric || ''}
                disabled
                className={`${inputCls} bg-gray-50 text-gray-500`}
              />
            )}
          </Field>

          {/* Fabric is bought in taga and worked in metres, and no factor
              converts the two — the user counts and enters it. A UM that IS
              metres says so itself, and Readymade (or anything bought in dozens)
              has no metres at all. Next to Received Qty because they describe
              the same delivery. */}
          {takesMetres && (metresFromQty ? (
            <Field label="Qty in metres" hint={`Same as Received Qty — the UM is ${umLabel}`}>
              <input value={form.received_qty === '' ? '' : fmtNum(form.received_qty)} disabled className={`${inputCls} bg-gray-50 text-gray-500`} />
            </Field>
          ) : (
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
          ))}

          {/* Goods bought in already stitched or later arrive as countable
              pieces. A UM in dozens is that count already, and Readymade by the
              piece is twelve to the dozen -- shown, not asked. */}
          {dozens && !graded && (dozensDerivable ? (
            <Field
              label="Dozens Received"
              hint={type === READYMADE && umKind(umLabel) === 'piece'
                ? `${fmtNum(form.received_qty || 0)} ${umLabel} ÷ 12 — worked out for you`
                : `Same as Received Qty — the UM is ${umLabel}`}
            >
              <input value={settled == null ? '' : fmtNum(settled)} disabled className={`${inputCls} bg-gray-50 text-gray-500`} />
            </Field>
          ) : (
            <Field
              label="Dozens Received"
              required
              hint="How many dozen arrived on this delivery"
            >
              <input
                type="number" min={0.01} step="0.01"
                value={form.received_dozens}
                onChange={e => setField('received_dozens', e.target.value)}
                className={inputCls}
              />
            </Field>
          ))}

          {/* Goods bought in at Packing, Panchal or Third Party arrive graded,
              exactly as a challan into those stages does: one box per grade, 0
              until filled in, and Dozens Received is their sum -- or, when the
              UM already says how many dozens came, the split of that figure. */}
          {graded && (
            <Field
              label="Dozens Received, by grade"
              required
              hint={dozensDerivable
                ? `Total ${gradeTotal} dozen — must add up to ${settled == null ? 'the Received Qty' : `${fmtNum(settled)} dozen`}`
                : `Total ${gradeTotal} dozen — enter at least one grade`}
              className="sm:col-span-2"
            >
              <div className="grid grid-cols-3 gap-2">
                {GRADE_FIELDS.map(([gradeType, col]) => (
                  <label key={col} className="block">
                    <span className="block text-[11px] text-gray-500 mb-0.5">{gradeType}</span>
                    <input
                      type="number" min={0} step="0.01"
                      value={form[col]}
                      onChange={e => setField(col, e.target.value)}
                      className={inputCls}
                    />
                  </label>
                ))}
              </div>
            </Field>
          )}

          {dozens && takesMetres && (
            <Field label="Metre per Dozen" hint="Metres divided by dozens — worked out for you">
              <input
                value={perDozen == null ? '' : fmtNum(perDozen)}
                disabled
                className={`${inputCls} bg-gray-50 text-gray-500`}
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

          {/* A sale takes no incoming number -- nothing arrives anywhere -- and
              records our outbound bill and who checked the goods over instead,
              the same two questions a challan into Third Party asks. */}
          {sale ? (
            <>
              <Field label="Outbound Bill No" required hint="Our invoice to the buyer — the only handle on goods that have left">
                <input
                  value={form.outbound_bill_no}
                  onChange={e => setField('outbound_bill_no', e.target.value)}
                  className={inputCls}
                  maxLength={INCOMING_NO_MAX}
                />
              </Field>
              <Field label="Checked By" required hint="A Warehouse POC who checked the goods over">
                <select
                  value={form.checked_by === '' || form.checked_by == null ? '' : String(form.checked_by)}
                  onChange={e => setField('checked_by', e.target.value)}
                  className={inputCls}
                >
                  <option value="">Select…</option>
                  {checkerOptionsFor(checkers, receipt?.incoming_stage === EXIT_STAGE ? receipt.checked_by : null, receipt?.checked_by_name).map(o => (
                    <option key={o.value} value={String(o.value)}>{o.label}</option>
                  ))}
                </select>
              </Field>
            </>
          ) : (
            <Field
              label="Incoming No"
              required={stitching}
              hint={stitching
                ? 'The gate register number — the code that prints before it follows from the stage'
                : 'Free text — the gate register reference'}
            >
              <input
                value={form.incoming_no}
                onChange={e => setField('incoming_no', e.target.value)}
                className={inputCls}
                maxLength={INCOMING_NO_MAX}
                placeholder="e.g. 0077"
              />
            </Field>
          )}

          {/* A paragraph for whoever reads this PO next. Shown in full, wrapped,
              in the receipts table. */}
          <Field label="Note" hint={`Optional — up to ${NOTE_MAX} characters`} className="sm:col-span-2">
            <textarea
              rows={3}
              value={form.note}
              onChange={e => setField('note', e.target.value)}
              className={inputCls}
              maxLength={NOTE_MAX}
              placeholder="e.g. Two bales arrived damp — vendor informed"
            />
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
