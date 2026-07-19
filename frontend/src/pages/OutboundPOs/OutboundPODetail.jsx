import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { ArrowLeft, Plus, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import AppShell from '../../components/layout/AppShell';
import Button from '../../components/ui/Button';
import Badge from '../../components/ui/Badge';
import { HistoryButton } from '../../components/shared/HistoryDrawer';
import { listOutboundVendors } from '../../api/outboundVendors.api';
import { listCompanies } from '../../api/companies.api';
import { getOutboundPO, createOutboundPO, updateOutboundPO } from '../../api/outboundPOs.api';

const STATUS_COLORS = { Open: 'blue', 'Partially Received': 'yellow', Closed: 'green', Deleted: 'gray' };

const today = () => new Date().toISOString().slice(0, 10);
const emptyLine = () => ({ mapping: '', category: '', item_name: '', variant: '', qty: 1, rate: 0, received: 0, short: 0 });

// A mapping option's identity: the article tuple, joined so it can live in a
// <select> value. Matches are case-insensitive like the backend.
const mapKey = (a) => `${a.category}${a.item_name}${a.variant || ''}`.toLowerCase();
const mapLabel = (a) => `${a.category} · ${a.item_name}${a.variant ? ` · ${a.variant}` : ''}`;

// Mirrors the backend deriveStatus rule so the Status field previews live.
function deriveStatus(lines) {
  if (!lines.length) return 'Open';
  const done = lines.every(l => Number(l.received) + Number(l.short) >= Number(l.qty));
  if (done) return 'Closed';
  const started = lines.some(l => Number(l.received) > 0 || Number(l.short) > 0);
  return started ? 'Partially Received' : 'Open';
}

export default function OutboundPODetail() {
  const { id } = useParams();
  const isNew = !id;
  const navigate = useNavigate();

  const [vendors, setVendors] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [notFound, setNotFound] = useState(false);

  const [po, setPo] = useState({
    vendor_id: '', company_id: '', po_date: today(), status: 'Open', order_no: null,
  });
  const [lines, setLines] = useState([emptyLine()]);

  useEffect(() => {
    listOutboundVendors().then(setVendors).catch(() => toast.error('Failed to load vendors'));
    listCompanies().then(setCompanies).catch(() => {});
  }, []);

  useEffect(() => {
    if (isNew) return;
    setLoading(true);
    getOutboundPO(id)
      .then(data => {
        setPo({
          vendor_id: data.vendor_id, company_id: data.company_id || '', po_date: data.po_date || '',
          status: data.status, order_no: data.order_no,
        });
        setLines(data.lines.map(l => ({
          mapping: mapKey(l),
          category: l.category, item_name: l.item_name, variant: l.variant || '',
          qty: l.qty, rate: l.rate, received: l.received, short: l.short,
        })));
      })
      .catch(err => {
        if (err.response?.status === 404) setNotFound(true);
        else toast.error('Failed to load PO');
      })
      .finally(() => setLoading(false));
  }, [id, isNew]);

  const vendor = vendors.find(v => v.id === Number(po.vendor_id));

  // Options come from the vendor's current mappings; when editing, any stored
  // line tuple no longer in the config is kept as an extra (grandfathered)
  // option so old POs still render and re-save.
  const mappingOptions = useMemo(() => {
    const opts = new Map();
    for (const a of vendor?.articles || []) opts.set(mapKey(a), mapLabel(a));
    for (const l of lines) {
      if (l.category && !opts.has(l.mapping)) {
        opts.set(l.mapping, mapLabel(l) + ' (removed from vendor config)');
      }
    }
    return [...opts.entries()].map(([value, label]) => ({ value, label }));
  }, [vendor, lines]);

  const setLine = (idx, patch) => {
    setLines(ls => {
      const next = ls.slice();
      next[idx] = { ...next[idx], ...patch };
      return next;
    });
  };
  const pickMapping = (idx, value) => {
    const fromVendor = (vendor?.articles || []).find(a => mapKey(a) === value);
    if (fromVendor) {
      setLine(idx, { mapping: value, category: fromVendor.category, item_name: fromVendor.item_name, variant: fromVendor.variant || '' });
    } else {
      setLine(idx, { mapping: value });
    }
  };
  const addLine = () => setLines(ls => [...ls, emptyLine()]);
  const removeLine = (idx) => setLines(ls => ls.filter((_, i) => i !== idx));

  const changeVendor = (vendorId) => {
    setPo(p => ({ ...p, vendor_id: vendorId }));
    // Different vendor = different mapping catalogue; reset picked articles.
    setLines(ls => ls.map(l => ({ ...l, mapping: '', category: '', item_name: '', variant: '' })));
  };

  const pendingOf = (l) => Math.max(0, Number(l.qty) - Number(l.received) - Number(l.short));
  const totalOf = (l) => Number(l.qty) * Number(l.rate);
  const grandTotal = lines.reduce((s, l) => s + totalOf(l), 0);
  const liveStatus = isNew ? 'Open' : (po.status === 'Deleted' ? 'Deleted' : deriveStatus(lines));
  const readOnly = po.status === 'Deleted';

  const handleSave = async (e) => {
    e.preventDefault();
    if (!po.vendor_id) { toast.error('Select a vendor'); return; }
    if (lines.some(l => !l.category)) { toast.error('Every line needs an article'); return; }
    const payload = {
      company_id: po.company_id || null,
      po_date: po.po_date || null,
      lines: lines.map((l, i) => ({
        line_no: i + 1,
        category: l.category, item_name: l.item_name, variant: l.variant || null,
        qty: Number(l.qty), rate: Number(l.rate),
        received: Number(l.received) || 0, short: Number(l.short) || 0,
      })),
    };
    setSaving(true);
    try {
      if (isNew) {
        const res = await createOutboundPO({ ...payload, vendor_id: Number(po.vendor_id) });
        toast.success(`Outbound PO ${res.order_no} created`);
        navigate('/outbound/purchase-orders');
      } else {
        const res = await updateOutboundPO(id, payload);
        setPo(p => ({ ...p, status: res.status }));
        toast.success(`PO ${res.order_no} saved`);
      }
    } catch (err) {
      toast.error(err.response?.data?.message || 'Save failed');
    } finally { setSaving(false); }
  };

  if (notFound) {
    return (
      <AppShell>
        <p className="text-gray-500">Outbound PO not found. <Link className="text-[#c1121f] underline" to="/outbound/purchase-orders">Back to list</Link></p>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Link to="/outbound/purchase-orders" className="p-2 rounded-lg hover:bg-gray-100 text-gray-500"><ArrowLeft size={18} /></Link>
          <div>
            <h1 className="text-2xl font-bold text-[#003049]">
              {isNew ? 'New Outbound PO' : `Outbound PO ${po.order_no || ''}`}
            </h1>
            {!isNew && (
              <div className="flex items-center gap-2 mt-1">
                <Badge color={STATUS_COLORS[liveStatus] || 'gray'}>{liveStatus}</Badge>
              </div>
            )}
          </div>
        </div>
        {!isNew && <HistoryButton entityType="outbound_po" entityId={Number(id)} title={`PO ${po.order_no} history`} />}
      </div>

      {loading ? (
        <div className="space-y-3">
          {[...Array(4)].map((_, i) => <div key={i} className="h-10 bg-gray-100 rounded-lg animate-pulse" />)}
        </div>
      ) : (
        <form onSubmit={handleSave} className="space-y-5">
          <div className="bg-white border border-gray-200 rounded-xl p-4">
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
              <Field label="Vendor" required>
                <select
                  value={po.vendor_id}
                  onChange={e => changeVendor(e.target.value)}
                  disabled={!isNew}
                  className={`${inputCls} ${!isNew ? 'bg-gray-50 text-gray-600' : ''}`}
                >
                  <option value="">Select vendor...</option>
                  {vendors.filter(v => v.is_active || v.id === Number(po.vendor_id)).map(v => (
                    <option key={v.id} value={v.id}>{v.name}</option>
                  ))}
                </select>
              </Field>
              <Field label="PO Date">
                <input type="date" value={po.po_date || ''} onChange={e => setPo(p => ({ ...p, po_date: e.target.value }))} disabled={readOnly} className={inputCls} />
              </Field>
              <Field label="Company">
                <select value={po.company_id || ''} onChange={e => setPo(p => ({ ...p, company_id: e.target.value }))} disabled={readOnly} className={inputCls}>
                  <option value="">Select company...</option>
                  {companies.filter(c => c.is_active || c.id === Number(po.company_id)).map(c => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </Field>
              <Field label="Status">
                <input disabled value={liveStatus} className={`${inputCls} bg-gray-50 text-gray-600`} />
              </Field>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-[#003049]">
                Line Items ({lines.length})
                <span className="ml-2 text-gray-500 font-normal">· Total ₹{grandTotal.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</span>
              </h3>
              {!readOnly && <Button type="button" variant="ghost" onClick={addLine}><Plus size={14} />Add Line</Button>}
            </div>
            <div className="overflow-x-auto bg-white border border-gray-200 rounded-lg">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    <th className="px-3 py-2 text-left font-semibold text-gray-600 w-12">Line</th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-600 min-w-[240px]">Article (Category · Item · Variant)</th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-600 w-24">Qty</th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-600 w-28">Rate</th>
                    {!isNew && (
                      <>
                        <th className="px-3 py-2 text-left font-semibold text-gray-600 w-24">Received</th>
                        <th className="px-3 py-2 text-left font-semibold text-gray-600 w-24">Short</th>
                        <th className="px-3 py-2 text-left font-semibold text-gray-600 w-20">Pending</th>
                      </>
                    )}
                    <th className="px-3 py-2 text-left font-semibold text-gray-600 w-28">Total</th>
                    {!readOnly && <th className="px-3 py-2 w-12" />}
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, idx) => (
                    <tr key={idx} className="border-b border-gray-100">
                      <td className="px-3 py-2 text-gray-700">{idx + 1}</td>
                      <td className="px-3 py-2">
                        <select
                          value={l.mapping}
                          onChange={e => pickMapping(idx, e.target.value)}
                          disabled={readOnly || !po.vendor_id}
                          className={cellCls}
                        >
                          <option value="">{po.vendor_id ? 'Select article...' : 'Select vendor first'}</option>
                          {mappingOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      </td>
                      <td className="px-3 py-2">
                        <input type="number" min={1} value={l.qty} onChange={e => setLine(idx, { qty: e.target.value })} disabled={readOnly} className={cellCls} />
                      </td>
                      <td className="px-3 py-2">
                        <input type="number" min={0} step="0.01" value={l.rate} onChange={e => setLine(idx, { rate: e.target.value })} disabled={readOnly} className={cellCls} />
                      </td>
                      {!isNew && (
                        <>
                          <td className="px-3 py-2">
                            <input type="number" min={0} value={l.received} onChange={e => setLine(idx, { received: e.target.value })} disabled={readOnly} className={cellCls} />
                          </td>
                          <td className="px-3 py-2">
                            <input type="number" min={0} value={l.short} onChange={e => setLine(idx, { short: e.target.value })} disabled={readOnly} className={cellCls} />
                          </td>
                          <td className={`px-3 py-2 font-semibold ${pendingOf(l) > 0 ? 'text-amber-700' : 'text-gray-700'}`}>{pendingOf(l)}</td>
                        </>
                      )}
                      <td className="px-3 py-2 text-gray-800 font-medium whitespace-nowrap">₹{totalOf(l).toLocaleString('en-IN', { maximumFractionDigits: 2 })}</td>
                      {!readOnly && (
                        <td className="px-3 py-2">
                          <button
                            type="button"
                            onClick={() => removeLine(idx)}
                            disabled={lines.length === 1}
                            title="Remove line"
                            className="p-1.5 rounded hover:bg-red-50 text-red-500 disabled:opacity-30 disabled:hover:bg-transparent"
                          >
                            <Trash2 size={14} />
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {po.vendor_id && vendor && vendor.articles.length === 0 && (
              <p className="mt-2 text-xs text-amber-600">
                This vendor has no article mappings yet — add them under Outbound → Vendors first.
              </p>
            )}
          </div>

          {!readOnly && (
            <div className="flex justify-end gap-3">
              <Button variant="ghost" type="button" onClick={() => navigate('/outbound/purchase-orders')}>Cancel</Button>
              <Button type="submit" loading={saving}>{isNew ? 'Create PO' : 'Save Changes'}</Button>
            </div>
          )}
        </form>
      )}
    </AppShell>
  );
}

const inputCls = 'w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f] disabled:bg-gray-50 disabled:text-gray-600';
const cellCls = 'w-full px-2 py-1 border border-gray-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-[#c1121f]/40 focus:border-[#c1121f] disabled:bg-gray-50 disabled:text-gray-600';

function Field({ label, required, children }) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1">
        {label} {required && <span className="text-red-500">*</span>}
      </label>
      {children}
    </div>
  );
}
