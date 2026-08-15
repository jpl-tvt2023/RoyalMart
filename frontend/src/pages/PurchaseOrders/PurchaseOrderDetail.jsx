import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Save, ArrowLeft, Download, Trash2, Plus } from 'lucide-react';
import toast from 'react-hot-toast';
import * as XLSX from 'xlsx';
import AppShell from '../../components/layout/AppShell';
import Button from '../../components/ui/Button';
import { getPO, updatePO } from '../../api/marketplacePO.api';
import { listCities } from '../../api/cities.api';
import { sortByText } from '../../utils/sort';
import { usesPickupDate } from '../../utils/pickupDate';
import { isValidDateString } from '../../utils/dateValidation';

// Line-item columns shared by the on-screen table header and the XLSX export so
// their labels/order can't drift apart. `width` styles the <th>; `xlsx` derives
// the exported cell value. (Body cells render editable inputs separately.)
const LINE_COLUMNS = [
  { label: 'Line',              width: 'w-16', xlsx: (l, idx) => Number(l.line_no) || idx + 1 },
  { label: 'Item Code/EAN',     width: 'w-40', xlsx: (l) => l.item_code || '' },
  { label: 'Internal SKU Code', width: '',     xlsx: (l) => l.internal_sku_code || '' },
  { label: 'Qty',               width: 'w-24', xlsx: (l) => Number(l.qty) || 0 },
];

export default function PurchaseOrderDetail() {
  const { poId } = useParams();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(null);
  const [cities, setCities] = useState([]);

  useEffect(() => {
    getPO(poId)
      .then(po => setForm({
        vendor: po.vendor,
        vendor_po_id: po.vendor_po_id || '',
        po_date: po.po_date || '',
        po_expiry_date: po.po_expiry_date || '',
        pickup_date: po.pickup_date || '',
        appointment_date: po.appointment_date || '',
        city: po.city || '',
        lines: (po.lines || []).map(l => ({ ...l })),
      }))
      .catch(() => toast.error('Failed to load PO'))
      .finally(() => setLoading(false));
  }, [poId]);

  useEffect(() => {
    listCities()
      .then(rows => setCities(sortByText(rows.filter(c => c.is_active).map(c => c.name))))
      .catch(() => {});
  }, []);

  const set = (patch) => setForm(f => ({ ...f, ...patch }));
  const lines = form?.lines || [];
  const totalQty = lines.reduce((s, l) => s + (Number(l.qty) || 0), 0);

  const updateLine = (idx, patch) => {
    const next = lines.slice();
    next[idx] = { ...next[idx], ...patch };
    set({ lines: next });
  };
  const addLine = () => {
    const nextNo = lines.reduce((m, l) => Math.max(m, Number(l.line_no) || 0), 0) + 1;
    set({ lines: [...lines, { line_no: nextNo, item_code: '', qty: 1 }] });
  };
  const removeLine = (idx) => set({ lines: lines.filter((_, i) => i !== idx) });

  const isPickupVendor = usesPickupDate(form?.vendor);

  const handleSave = async () => {
    if (!form.vendor_po_id?.trim()) return toast.error('PO Number is required');
    if (!form.city) return toast.error('City is required');
    if (isPickupVendor && !form.pickup_date) return toast.error(`Pickup date is required for ${form.vendor} POs`);
    if (!form.lines?.length) return toast.error('At least one line item is required');
    for (const [label, value] of [['PO date', form.po_date], ['Pickup date', form.pickup_date], ['PO expiry date', form.po_expiry_date]]) {
      if (value && !isValidDateString(value)) return toast.error(`${label} has an invalid year`);
    }
    setSaving(true);
    try {
      await updatePO(poId, {
        vendor_po_id: form.vendor_po_id,
        po_date: form.po_date,
        po_expiry_date: form.po_expiry_date,
        pickup_date: form.pickup_date,
        city: form.city,
        lines: form.lines,
      });
      toast.success('Saved');
      navigate('/purchase-orders');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Save failed');
    } finally { setSaving(false); }
  };

  const downloadXLSX = () => {
    const dateLabel = isPickupVendor ? 'Pickup Date' : 'Exp Date';
    const dateValue = (isPickupVendor ? form.pickup_date : form.po_expiry_date) || '';
    const headerRow = ['POID', 'Vendor', 'PO Number', 'City', 'PO Date', dateLabel, 'Appointment Date'];
    const valueRow = [poId, form.vendor || '', form.vendor_po_id || '', form.city || '', form.po_date || '', dateValue, form.appointment_date || ''];
    const countsHeader = ['Line Count', 'Total Quantity'];
    const countsValues = [lines.length, totalQty];
    const lineHeader = LINE_COLUMNS.map(c => c.label);
    const lineRows = lines.map((l, idx) => LINE_COLUMNS.map(c => c.xlsx(l, idx)));

    const aoa = [
      headerRow,
      valueRow,
      [],
      countsHeader,
      countsValues,
      [],
      lineHeader,
      ...lineRows,
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Purchase Order');
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
    XLSX.writeFile(wb, `PO-${poId}-${stamp}.xlsx`);
  };

  return (
    <AppShell>
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Button variant="ghost" onClick={() => navigate('/purchase-orders')}><ArrowLeft size={16} />Back</Button>
          <div>
            <h1 className="text-2xl font-bold text-[#003049]">Purchase Order {poId}</h1>
            <p className="text-gray-500 text-sm">{form?.vendor} · {form?.vendor_po_id}</p>
          </div>
        </div>
        {form && (
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={downloadXLSX}><Download size={16} />Download XLSX</Button>
            <Button onClick={handleSave} loading={saving}><Save size={16} />Save Changes</Button>
          </div>
        )}
      </div>

      {loading && <div className="bg-white rounded-xl border border-gray-200 p-6 animate-pulse h-64" />}
      {!loading && form && (
        <div className="space-y-5">
          <div className="bg-white border border-gray-200 rounded-xl p-5">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Field label="POID">
                <input disabled value={poId} className={`${inputCls} bg-gray-50 text-gray-600 font-mono`} />
              </Field>
              <Field label="PO Number">
                <input value={form.vendor_po_id || ''} onChange={e => set({ vendor_po_id: e.target.value })} className={`${inputCls} font-mono`} />
              </Field>
              <Field label="City">
                <select value={form.city || ''} onChange={e => set({ city: e.target.value })} className={inputCls}>
                  <option value="">Select city...</option>
                  {cities.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </Field>
              <Field label="PO Date">
                <input type="date" value={form.po_date || ''} onChange={e => set({ po_date: e.target.value })} className={inputCls} />
              </Field>
              {isPickupVendor ? (
                <Field label="Pickup Date">
                  <input type="date" value={form.pickup_date || ''} onChange={e => set({ pickup_date: e.target.value })} className={inputCls} />
                </Field>
              ) : (
                <Field label="Exp Date">
                  <input type="date" value={form.po_expiry_date || ''} onChange={e => set({ po_expiry_date: e.target.value })} className={inputCls} />
                </Field>
              )}
              <Field label="Appointment Date">
                <input disabled value={form.appointment_date || ''} className={`${inputCls} bg-gray-50 text-gray-600`} placeholder="Set on GRN screen" />
              </Field>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-[#003049]">
                Line Items ({lines.length})
                <span className="ml-2 text-gray-500 font-normal">· Total Quantity {totalQty}</span>
              </h3>
              <Button type="button" variant="ghost" onClick={addLine}><Plus size={14} />Add Line</Button>
            </div>
            <div className="overflow-x-auto bg-white border border-gray-200 rounded-lg">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    {LINE_COLUMNS.map(c => (
                      <th key={c.label} className={`px-3 py-2 text-left font-semibold text-gray-600 ${c.width}`}>{c.label}</th>
                    ))}
                    <th className="px-3 py-2 w-12" />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((ln, idx) => (
                    <tr key={idx} className="border-b border-gray-100">
                      <td className="px-3 py-2 text-gray-700">{idx + 1}</td>
                      <td className="px-3 py-2">
                        <input value={ln.item_code || ''} onChange={e => updateLine(idx, { item_code: e.target.value })} className={cellCls} />
                      </td>
                      <td className="px-3 py-2 text-gray-700 font-mono text-xs">
                        {ln.internal_sku_code || '—'}
                      </td>
                      <td className="px-3 py-2">
                        <input type="number" min={1} value={ln.qty || ''} onChange={e => updateLine(idx, { qty: Number(e.target.value) })} className={cellCls} />
                      </td>
                      <td className="px-3 py-2">
                        <button type="button" onClick={() => removeLine(idx)} title="Remove line" className="p-1.5 rounded hover:bg-red-50 text-red-500"><Trash2 size={14} /></button>
                      </td>
                    </tr>
                  ))}
                  {lines.length === 0 && (
                    <tr><td colSpan={5} className="px-3 py-6 text-center text-gray-400">No line items</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}

const inputCls = 'w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f]';
const cellCls = 'w-full px-2 py-1 border border-gray-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-[#c1121f]/40 focus:border-[#c1121f]';

function Field({ label, children }) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
      {children}
    </div>
  );
}
