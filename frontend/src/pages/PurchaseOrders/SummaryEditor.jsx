import { useEffect, useState } from 'react';
import { Trash2, Plus } from 'lucide-react';
import Button from '../../components/ui/Button';
import { listCities } from '../../api/cities.api';
import { sortByText } from '../../utils/sort';

export default function SummaryEditor({ value, onChange, showVendor = false, readOnlyVendor = true, onboarderSlot = null }) {
  const [cities, setCities] = useState([]);
  useEffect(() => {
    listCities()
      .then(rows => setCities(sortByText(rows.filter(c => c.is_active).map(c => c.name))))
      .catch(() => {});
  }, []);
  const set = (patch) => onChange({ ...value, ...patch });
  const lines = value.lines || [];

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
  const totalQty = lines.reduce((s, l) => s + (Number(l.qty) || 0), 0);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {showVendor && (
          <Field label="Vendor">
            <input disabled={readOnlyVendor} value={value.vendor || ''} onChange={e => set({ vendor: e.target.value })} className={inputCls} />
          </Field>
        )}
        <Field label="Vendor PO No.">
          <input value={value.vendor_po_id || ''} onChange={e => set({ vendor_po_id: e.target.value })} className={inputCls} />
        </Field>
        <Field label="Party Name (Ship-To, parsed)">
          <input value={value.party_name || ''} onChange={e => set({ party_name: e.target.value })} placeholder="—" className={inputCls} />
        </Field>
        <Field label="PO Date">
          <input type="date" value={value.po_date || ''} onChange={e => set({ po_date: e.target.value })} className={inputCls} />
        </Field>
        <Field label="PO Expiry Date">
          <input type="date" value={value.po_expiry_date || ''} onChange={e => set({ po_expiry_date: e.target.value })} className={inputCls} />
        </Field>
        <Field label="City">
          <select value={value.city || ''} onChange={e => set({ city: e.target.value })} className={inputCls}>
            <option value="">Select city...</option>
            {cities.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </Field>
        <Field label="Status">
          <input disabled value={value.status || 'Open'} className={`${inputCls} bg-gray-50 text-gray-600`} />
        </Field>
        {onboarderSlot}
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
                <th className="px-3 py-2 text-left font-semibold text-gray-600 w-16">Line</th>
                <th className="px-3 py-2 text-left font-semibold text-gray-600 w-40">Item Code/EAN</th>
                <th className="px-3 py-2 text-left font-semibold text-gray-600">Internal SKU Code</th>
                <th className="px-3 py-2 text-left font-semibold text-gray-600 w-24">Qty</th>
                <th className="px-3 py-2 w-12" />
              </tr>
            </thead>
            <tbody>
              {lines.map((ln, idx) => (
                <tr key={idx} className="border-b border-gray-100">
                  <td className="px-3 py-2">
                    <input type="number" min={1} value={ln.line_no || ''} onChange={e => updateLine(idx, { line_no: Number(e.target.value) })} className={cellCls} />
                  </td>
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
