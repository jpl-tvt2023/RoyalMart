import { useEffect, useRef, useState } from 'react';
import { Trash2, Plus } from 'lucide-react';
import Button from '../../components/ui/Button';
import { listCities } from '../../api/cities.api';
import { getVendorCodes } from '../../api/productVendorCodes.api';
import { listPartyNames } from '../../api/marketplacePO.api';
import PartyNameInput from '../../components/ui/PartyNameInput';
import { sortByText } from '../../utils/sort';
import { usesPickupDate } from '../../utils/pickupDate';

export default function SummaryEditor({ value, onChange, showVendor = false, readOnlyVendor = true, codePicker = false, manual = false, onboarderSlot = null }) {
  const [cities, setCities] = useState([]);
  useEffect(() => {
    listCities()
      .then(rows => setCities(sortByText(rows.filter(c => c.is_active).map(c => c.name))))
      .catch(() => {});
  }, []);

  // Manual onboarding: load this vendor's mapped codes so the Item Code cell can
  // offer a type-ahead (`vendor_item_code - {sku_code}`) that resolves the SKU.
  const vendor = value.vendor;
  const [codeOptions, setCodeOptions] = useState([]);
  const [codesLoaded, setCodesLoaded] = useState(false);
  useEffect(() => {
    if (!codePicker || !vendor) { setCodeOptions([]); setCodesLoaded(false); return; }
    let alive = true;
    setCodesLoaded(false);
    getVendorCodes(vendor)
      .then(res => {
        if (!alive) return;
        setCodeOptions((res.data || []).map(r => ({
          vendor_item_code: String(r.vendor_item_code),
          sku_code: r.sku_code,
          product_id: r.product_id,
        })));
        setCodesLoaded(true);
      })
      .catch(() => { if (alive) { setCodeOptions([]); setCodesLoaded(true); } });
    return () => { alive = false; };
  }, [codePicker, vendor]);

  // Party names have no master table -- suggest the ones this vendor has used
  // before so spellings stay consistent, while still allowing a new one.
  const [partyNames, setPartyNames] = useState([]);
  useEffect(() => {
    let alive = true;
    Promise.resolve(vendor ? listPartyNames(vendor) : [])
      .then(rows => { if (alive) setPartyNames(rows || []); })
      .catch(() => { if (alive) setPartyNames([]); });
    return () => { alive = false; };
  }, [vendor]);

  const useCombobox = codePicker && codeOptions.length > 0;
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
        <Field label={manual ? 'Party Name' : 'Party Name (Ship-To, parsed)'}>
          <PartyNameInput
            value={value.party_name || ''}
            options={partyNames}
            onChange={v => set({ party_name: v })}
            className={inputCls}
          />
        </Field>
        <Field label="Delivery Code (Ship-To, parsed)">
          <input value={value.delivery_code || ''} onChange={e => set({ delivery_code: e.target.value })} placeholder="—" className={inputCls} />
        </Field>
        <Field label="PO Date">
          <input type="date" value={value.po_date || ''} onChange={e => set({ po_date: e.target.value })} className={inputCls} />
        </Field>
        {usesPickupDate(value.vendor) ? (
          <Field label="Pickup Date">
            <input type="date" value={value.pickup_date || ''} onChange={e => set({ pickup_date: e.target.value })} className={inputCls} />
          </Field>
        ) : (
          <Field label="PO Expiry Date">
            <input type="date" value={value.po_expiry_date || ''} onChange={e => set({ po_expiry_date: e.target.value })} className={inputCls} />
          </Field>
        )}
        <Field label="City">
          <select value={value.city || ''} onChange={e => set({ city: e.target.value })} className={inputCls}>
            <option value="">Select city...</option>
            {cities.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </Field>
        <Field label="Status">
          <input disabled value={value.status || 'Open'} className={`${inputCls} bg-gray-50 text-gray-600`} />
        </Field>
        {value.vendor === 'Minutes' && (
          <Field label="Appointment Date">
            <input type="date" value={value.appointment_date || ''} onChange={e => set({ appointment_date: e.target.value })} className={inputCls} />
          </Field>
        )}
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
        <div className={`${useCombobox ? 'overflow-visible' : 'overflow-x-auto'} bg-white border border-gray-200 rounded-lg`}>
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
                  <td className="px-3 py-2 text-gray-700">{idx + 1}</td>
                  <td className="px-3 py-2">
                    {useCombobox ? (
                      <ItemCodeCombobox
                        value={ln.item_code || ''}
                        options={codeOptions}
                        onSelect={(o) => updateLine(idx, {
                          item_code: o.vendor_item_code,
                          internal_sku_code: o.sku_code,
                          internal_product_id: o.product_id,
                        })}
                      />
                    ) : (
                      <input value={ln.item_code || ''} onChange={e => updateLine(idx, { item_code: e.target.value })} className={cellCls} />
                    )}
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
        {codePicker && codesLoaded && codeOptions.length === 0 && (
          <p className="mt-2 text-xs text-amber-600">
            No vendor mappings found for {vendor || 'this vendor'} — type the item code manually, or add mappings under Products → Vendor Mappings to enable code suggestions.
          </p>
        )}
      </div>
    </div>
  );
}

// Type-ahead for a manual PO line's Item Code, scoped to the vendor's mapped
// codes. Typing filters by vendor code or SKU; picking a suggestion sets the
// item code and (via onSelect) auto-fills the read-only Internal SKU cell.
function ItemCodeCombobox({ value, options, onSelect }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  const q = (open ? query : value).trim().toLowerCase();
  const matches = options.filter(o =>
    !q ||
    o.vendor_item_code.toLowerCase().includes(q) ||
    (o.sku_code || '').toLowerCase().includes(q)
  ).slice(0, 50);

  const pick = (o) => { onSelect(o); setQuery(o.vendor_item_code); setOpen(false); };

  return (
    <div className="relative" ref={ref}>
      <input
        value={open ? query : (value || '')}
        onFocus={() => { setQuery(value || ''); setOpen(true); }}
        onChange={e => { setQuery(e.target.value); setOpen(true); }}
        placeholder="Type to search codes…"
        className={cellCls}
      />
      {open && (
        <ul className="absolute z-30 left-0 right-0 mt-1 max-h-56 overflow-auto rounded-lg border border-gray-200 bg-white shadow-lg text-sm">
          {matches.length === 0 ? (
            <li className="px-3 py-2 text-gray-400">No matching codes</li>
          ) : matches.map(o => (
            <li key={o.vendor_item_code}>
              <button
                type="button"
                onMouseDown={e => e.preventDefault()}
                onClick={() => pick(o)}
                className="w-full text-left px-3 py-1.5 hover:bg-gray-50"
              >
                <span className="font-mono">{o.vendor_item_code}</span>
                <span className="text-gray-400"> - </span>
                <span className="font-mono text-xs text-gray-600">{o.sku_code || '—'}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
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
