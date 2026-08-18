import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { ArrowLeft, Plus, Trash2, RotateCcw, Save, Download, X, AlertTriangle } from 'lucide-react';
import * as XLSX from 'xlsx';
import toast from 'react-hot-toast';
import AppShell from '../../components/layout/AppShell';
import Button from '../../components/ui/Button';
import Badge from '../../components/ui/Badge';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import { HistoryButton } from '../../components/shared/HistoryDrawer';
import { listOutboundVendors } from '../../api/outboundVendors.api';
import { listCompanies } from '../../api/companies.api';
import { listUsersLite } from '../../api/users.api';
import {
  getOutboundPO, createOutboundPO, updateOutboundPO,
  updateOutboundPOLineShort, addOutboundPOLineReceipt, updateOutboundPOLineReceipt,
  deleteOutboundPOLineReceipt, restoreOutboundPOLineReceipt,
} from '../../api/outboundPOs.api';
import { ROLES } from '../../utils/roles';
import { FLAG_META } from '../../utils/outboundPOFlags';
import { isValidDateString } from '../../utils/dateValidation';
import { formatDateTime } from '../../utils/formatters';

const STATUS_COLORS = { Open: 'blue', 'Partially Received': 'yellow', Closed: 'green', Deleted: 'gray' };

const today = () => new Date().toISOString().slice(0, 10);
const emptyLine = () => ({
  _key: `new-${Math.random().toString(36).slice(2)}`,
  id: null, mapping: '', category: '', item_name: '', variant: '',
  qty: 1, rate: 0, short: 0, received: 0, receipts: [], unit_metric: '', flags: [],
  updated_by_name: '', updated_at: null, deleted_at: null, deleted_by: null,
});

const EMPTY_RECEIPT = { received_qty: '', received_rate: '', bill_no: '', incoming_no: '', checked_by: '' };

// A mapping option's identity: the article tuple, joined so it can live in a
// <select> value. Matches are case-insensitive like the backend.
const mapKey = (a) => `${a.category}${a.item_name}${a.variant || ''}`.toLowerCase();
const mapLabel = (a) => `${a.category} · ${a.item_name}${a.variant ? ` · ${a.variant}` : ''}`;

// Per-line status, mirroring the backend's computeLineStatus.
function computeLineStatus(l) {
  const qty = Number(l.qty), received = Number(l.received) || 0, short = Number(l.short) || 0;
  if (received + short >= qty) return 'Closed';
  if (received > 0 || short > 0) return 'Partially Received';
  return 'Open';
}

// Mirrors the backend deriveStatus rule so the header Status previews live.
function deriveStatus(activeLines) {
  if (!activeLines.length) return 'Open';
  if (activeLines.every(l => computeLineStatus(l) === 'Closed')) return 'Closed';
  if (activeLines.some(l => computeLineStatus(l) !== 'Open')) return 'Partially Received';
  return 'Open';
}

function toLineState(l) {
  return {
    _key: String(l.id),
    id: l.id,
    mapping: mapKey(l),
    category: l.category, item_name: l.item_name, variant: l.variant || '',
    qty: l.qty, rate: l.rate, short: l.short, received: l.received,
    unit_metric: l.unit_metric || '',
    flags: l.flags || [],
    updated_by_name: l.updated_by_name, updated_at: l.updated_at,
    deleted_at: l.deleted_at, deleted_by: l.deleted_by,
    receipts: l.receipts || [],
  };
}

export default function OutboundPODetail() {
  const { id } = useParams();
  const isNew = !id;
  const navigate = useNavigate();

  const [vendors, setVendors] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [approvers, setApprovers] = useState([]);
  const [checkers, setCheckers] = useState([]);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [showDeleted, setShowDeleted] = useState(false);

  const [po, setPo] = useState({
    vendor_id: '', company_id: '', po_date: today(), status: 'Open', order_no: null,
    approved_by: '', approval_date: '',
  });
  const [originalApprovedBy, setOriginalApprovedBy] = useState('');
  const [lines, setLines] = useState([emptyLine()]);

  // Receiving Details working state (short drafts, receipt drafts/add-forms).
  const [shortDrafts, setShortDrafts] = useState({});
  const [savingShortKey, setSavingShortKey] = useState(null);
  const [addingReceiptFor, setAddingReceiptFor] = useState(null);
  const [newReceipt, setNewReceipt] = useState(EMPTY_RECEIPT);
  const [savingNewReceipt, setSavingNewReceipt] = useState(false);
  const [receiptDrafts, setReceiptDrafts] = useState({});
  const [savingReceiptId, setSavingReceiptId] = useState(null);
  const [confirmDeleteReceipt, setConfirmDeleteReceipt] = useState(null);
  const [deletingReceipt, setDeletingReceipt] = useState(false);
  const [restoringReceiptId, setRestoringReceiptId] = useState(null);

  useEffect(() => {
    listOutboundVendors().then(setVendors).catch(() => toast.error('Failed to load vendors'));
    listCompanies().then(setCompanies).catch(() => {});
    listUsersLite({ role: ROLES.PURCHASE_HEAD }).then(setApprovers).catch(() => {});
    listUsersLite({ role: ROLES.WAREHOUSE_POC }).then(setCheckers).catch(() => {});
  }, []);

  const load = () => {
    if (isNew) return;
    setLoading(true);
    getOutboundPO(id, { includeDeleted: true })
      .then(data => {
        setPo({
          vendor_id: data.vendor_id, company_id: data.company_id || '', po_date: data.po_date || '',
          status: data.status, order_no: data.order_no, approved_by: data.approved_by || '',
          approval_date: data.approval_date || '',
        });
        setOriginalApprovedBy(data.approved_by || '');
        setLines(data.lines.map(toLineState));
      })
      .catch(err => {
        if (err.response?.status === 404) setNotFound(true);
        else toast.error('Failed to load PO');
      })
      .finally(() => setLoading(false));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [id, isNew]);

  const vendor = vendors.find(v => v.id === Number(po.vendor_id));
  const activeLines = useMemo(() => lines.filter(l => !l.deleted_at), [lines]);
  const visibleLines = showDeleted ? lines : activeLines;

  // Options come from the vendor's current mappings; when editing, any stored
  // line tuple no longer in the config is kept as an extra (grandfathered)
  // option so old POs still render and re-save.
  const mappingOptions = useMemo(() => {
    const opts = new Map();
    for (const a of vendor?.articles || []) opts.set(mapKey(a), mapLabel(a));
    for (const l of activeLines) {
      if (l.category && !opts.has(l.mapping)) {
        opts.set(l.mapping, mapLabel(l) + ' (removed from vendor config)');
      }
    }
    return [...opts.entries()].map(([value, label]) => ({ value, label }));
  }, [vendor, activeLines]);

  const setLine = (key, patch) => setLines(ls => ls.map(l => l._key === key ? { ...l, ...patch } : l));
  const pickMapping = (key, value) => {
    const fromVendor = (vendor?.articles || []).find(a => mapKey(a) === value);
    if (fromVendor) {
      // unit_metric is shown immediately for feedback, but is not sent on save —
      // the server re-derives it from the catalog so a stale client value can
      // never overwrite the authoritative one.
      setLine(key, {
        mapping: value, category: fromVendor.category, item_name: fromVendor.item_name,
        variant: fromVendor.variant || '', unit_metric: fromVendor.unit_metric || '',
      });
    } else {
      setLine(key, { mapping: value });
    }
  };
  const addLine = () => setLines(ls => [...ls, emptyLine()]);
  const removeLine = (key) => setLines(ls => ls.filter(l => l._key !== key));

  const changeVendor = (vendorId) => {
    setPo(p => ({ ...p, vendor_id: vendorId }));
    // Different vendor = different mapping catalogue; reset picked articles.
    setLines(ls => ls.map(l => ({ ...l, mapping: '', category: '', item_name: '', variant: '' })));
  };

  // Counts flagged receipts (not lines) so the banner headline matches what the
  // user actually has to go and fix.
  const flagSummary = useMemo(() => {
    const counts = {};
    const flagged = new Set();
    for (const l of activeLines) {
      for (const r of l.receipts || []) {
        if (r.deleted_at || !(r.flags || []).length) continue;
        flagged.add(r.id);
        for (const k of r.flags) counts[k] = (counts[k] || 0) + 1;
      }
    }
    return {
      total: flagged.size,
      parts: Object.entries(counts).map(([k, n]) => `${n} ${FLAG_META[k]?.label || k}`),
    };
  }, [activeLines]);

  const pendingOf = (l) => Math.max(0, Number(l.qty) - Number(l.received || 0) - Number(l.short || 0));
  const liveStatus = isNew ? 'Open' : (po.status === 'Deleted' ? 'Deleted' : deriveStatus(activeLines));
  const readOnly = po.status === 'Deleted';

  const approverChanged = String(po.approved_by || '') !== String(originalApprovedBy || '');
  const approvalDateRequired = !!po.approved_by && approverChanged;

  const handleDownload = () => {
    setDownloading(true);
    try {
      const companyName = companies.find(c => c.id === Number(po.company_id))?.name || '';
      const totalQty = activeLines.reduce((s, l) => s + Number(l.qty || 0), 0);

      const dataRows = activeLines.map((l, idx) => [
        idx + 1, l.category, l.item_name, l.variant || '', l.qty, l.unit_metric || '', l.rate,
      ]);

      const aoa = [
        ['Order no.', po.order_no || ''],
        ['Order Date', po.po_date || ''],
        ['Vendor Name', vendor?.name || ''],
        ['Company Name', companyName],
        [],
        ['Sr.no.', 'Category', 'Item name', 'Variant', 'Qty', 'UM', 'Rate'],
        ...dataRows,
        ['', '', '', 'Total', totalQty, '', ''],
      ];

      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = aoa[5].map(() => ({ wch: 18 }));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Outbound PO');
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
      XLSX.writeFile(wb, `outbound-po-${po.order_no || 'new'}-${stamp}.xlsx`);
    } finally { setDownloading(false); }
  };

  const handleSave = async (e) => {
    e.preventDefault();
    if (!po.vendor_id) { toast.error('Select a vendor'); return; }
    if (activeLines.some(l => !l.category)) { toast.error('Every line needs an article'); return; }
    // Optional when first onboarding a PO, but every edit after that must carry an approver.
    if (!isNew && !po.approved_by) { toast.error('Approved By is required to save changes to this PO'); return; }
    if (approvalDateRequired && !po.approval_date) {
      toast.error('Approval Date is required when setting or changing the approver');
      return;
    }
    if (po.po_date && !isValidDateString(po.po_date)) { toast.error('PO date has an invalid year'); return; }
    if (po.approval_date && !isValidDateString(po.approval_date)) { toast.error('Approval date has an invalid year'); return; }
    const payload = {
      company_id: po.company_id || null,
      po_date: po.po_date || null,
      approved_by: po.approved_by || null,
      approval_date: po.approval_date || null,
      lines: activeLines.map((l, i) => ({
        id: l.id || undefined,
        line_no: i + 1,
        category: l.category, item_name: l.item_name, variant: l.variant || null,
        qty: Number(l.qty), rate: Number(l.rate),
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
        toast.success(`PO ${res.order_no} saved`);
        navigate('/outbound/purchase-orders');
      }
    } catch (err) {
      toast.error(err.response?.data?.message || 'Save failed');
    } finally { setSaving(false); }
  };

  // --- Receiving Details actions (short / receipts) ---

  const saveShort = async (l) => {
    const value = Number(shortDrafts[l._key]);
    if (!Number.isFinite(value) || value < 0) { toast.error('Short must be a number >= 0'); return; }
    setSavingShortKey(l._key);
    try {
      await updateOutboundPOLineShort(id, l.id, value);
      setShortDrafts(d => { const n = { ...d }; delete n[l._key]; return n; });
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to update Short');
    } finally { setSavingShortKey(null); }
  };

  // If a receipt's stored checker isn't in the live Warehouse_POC list (tagged
  // before the rule existed, or since untagged), keep them selectable so the
  // dropdown doesn't silently blank out a real recorded value.
  const checkerOptionsFor = (checkedById, checkedByName) => {
    const opts = checkers.map(u => ({ value: u.id, label: u.name }));
    if (checkedById && !opts.some(o => String(o.value) === String(checkedById))) {
      opts.push({ value: checkedById, label: `${checkedByName || 'Unknown'} (not Warehouse POC)` });
    }
    return opts;
  };

  // Mirrors the server's receipt rules — including their ORDER, so the message
  // shown here is the one the server would have returned — so the user gets the
  // error before a round trip. Returns an error string, or null when usable.
  //
  // requireBillNo is false only when editing a receipt that has never had one
  // (migration 053 synthesized those from the legacy flat `received` value, with
  // no bill to record). Those stay editable for unrelated fixes rather than
  // demanding a bill number nobody has — matching what the server enforces.
  const receiptFieldError = (v, { requireBillNo = true } = {}) => {
    if (!v.received_qty || Number(v.received_qty) <= 0) return 'Received Qty is required';
    if (v.received_rate === '' || v.received_rate == null) return 'Billed Rate is required';
    if (!Number.isFinite(Number(v.received_rate)) || Number(v.received_rate) < 0) return 'Billed Rate must be a number >= 0';
    if (!v.checked_by) return 'Checked By is required';
    if (requireBillNo && !String(v.bill_no ?? '').trim()) return 'Bill No is required';
    if (v.incoming_no !== '' && v.incoming_no != null) {
      const n = Number(v.incoming_no);
      if (!Number.isInteger(n) || n <= 0) return 'Incoming No must be a whole number > 0';
    }
    return null;
  };

  const startAddReceipt = (lineKey) => { setAddingReceiptFor(lineKey); setNewReceipt(EMPTY_RECEIPT); };
  const saveNewReceipt = async (l) => {
    const err = receiptFieldError(newReceipt);
    if (err) { toast.error(err); return; }
    setSavingNewReceipt(true);
    try {
      await addOutboundPOLineReceipt(id, l.id, {
        received_qty: Number(newReceipt.received_qty),
        received_rate: Number(newReceipt.received_rate),
        bill_no: newReceipt.bill_no || null,
        checked_by: Number(newReceipt.checked_by),
        incoming_no: newReceipt.incoming_no === '' ? null : Number(newReceipt.incoming_no),
      });
      toast.success('Receipt added');
      setAddingReceiptFor(null);
      load();
    } catch (err2) {
      toast.error(err2.response?.data?.message || 'Failed to add receipt');
    } finally { setSavingNewReceipt(false); }
  };

  const receiptValue = (r, field) => {
    const draft = receiptDrafts[r.id];
    if (draft && field in draft) return draft[field];
    return r[field] ?? '';
  };
  const setReceiptField = (r, field, value) => setReceiptDrafts(d => ({ ...d, [r.id]: { ...d[r.id], [field]: value } }));
  const saveReceipt = async (l, r) => {
    const draft = {
      received_qty: receiptValue(r, 'received_qty'),
      received_rate: receiptValue(r, 'received_rate'),
      checked_by: receiptValue(r, 'checked_by'),
      incoming_no: receiptValue(r, 'incoming_no'),
      bill_no: receiptValue(r, 'bill_no'),
    };
    // A receipt that already has a bill number must keep one — but one that
    // never had it can still be edited without inventing it.
    const hadBillNo = !!String(r.bill_no ?? '').trim();
    const err = receiptFieldError(draft, { requireBillNo: hadBillNo });
    if (err) { toast.error(err); return; }
    setSavingReceiptId(r.id);
    try {
      const billNo = String(draft.bill_no ?? '').trim();
      const payload = {
        received_qty: Number(draft.received_qty),
        received_rate: Number(draft.received_rate),
        checked_by: Number(draft.checked_by),
        incoming_no: draft.incoming_no === '' ? null : Number(draft.incoming_no),
      };
      // Omit bill_no entirely for a receipt that never had one, rather than
      // sending an explicit null. The server validates only the fields actually
      // present, so sending null would count as touching it and fail the
      // mandatory rule on an edit that has nothing to do with the bill number.
      if (billNo || hadBillNo) payload.bill_no = billNo || null;
      await updateOutboundPOLineReceipt(id, l.id, r.id, payload);
      setReceiptDrafts(d => { const n = { ...d }; delete n[r.id]; return n; });
      load();
    } catch (err2) {
      toast.error(err2.response?.data?.message || 'Failed to update receipt');
    } finally { setSavingReceiptId(null); }
  };
  const handleDeleteReceipt = async () => {
    setDeletingReceipt(true);
    try {
      await deleteOutboundPOLineReceipt(id, confirmDeleteReceipt.lineId, confirmDeleteReceipt.id);
      toast.success('Receipt deleted');
      setConfirmDeleteReceipt(null);
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Delete failed');
    } finally { setDeletingReceipt(false); }
  };
  const handleRestoreReceipt = async (l, r) => {
    setRestoringReceiptId(r.id);
    try {
      await restoreOutboundPOLineReceipt(id, l.id, r.id);
      toast.success('Receipt restored');
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Restore failed');
    } finally { setRestoringReceiptId(null); }
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
        {!isNew && (
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={handleDownload} loading={downloading}><Download size={16} />Download XLSX</Button>
            <HistoryButton entityType="outbound_po" entityId={Number(id)} title={`PO ${po.order_no} history`} />
          </div>
        )}
      </div>

      {loading ? (
        <div className="space-y-3">
          {[...Array(4)].map((_, i) => <div key={i} className="h-10 bg-gray-100 rounded-lg animate-pulse" />)}
        </div>
      ) : (
        <form onSubmit={handleSave} className="space-y-5">
          <div className="bg-white border border-gray-200 rounded-xl p-4">
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-6 gap-4">
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
              <Field label="Approved By" required={!isNew}>
                <select
                  value={po.approved_by || ''}
                  onChange={e => setPo(p => ({ ...p, approved_by: e.target.value, approval_date: '' }))}
                  disabled={readOnly}
                  className={inputCls}
                >
                  <option value="">{isNew ? 'Not yet approved' : 'Select approver...'}</option>
                  {approvers.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              </Field>
              <Field label="Approval Date" required={approvalDateRequired}>
                <input
                  type="date"
                  value={po.approval_date || ''}
                  onChange={e => setPo(p => ({ ...p, approval_date: e.target.value }))}
                  disabled={readOnly || !po.approved_by}
                  className={inputCls}
                />
              </Field>
            </div>
          </div>

          <div>
            {flagSummary.total > 0 && (
              <div className="mb-3 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm">
                <AlertTriangle size={16} className="text-amber-600 shrink-0 mt-0.5" />
                <div>
                  <span className="font-medium text-amber-900">
                    {flagSummary.total} receipt{flagSummary.total !== 1 ? 's' : ''} need attention:
                  </span>{' '}
                  <span className="text-amber-800">
                    {flagSummary.parts.join(', ')}
                  </span>
                  <div className="text-xs text-amber-700 mt-0.5">Highlighted in the table below.</div>
                </div>
              </div>
            )}
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-[#003049]">Line Items ({activeLines.length})</h3>
              <div className="flex items-center gap-4">
                {!isNew && (
                  <label className="flex items-center gap-2 text-xs text-gray-600">
                    <input type="checkbox" checked={showDeleted} onChange={e => setShowDeleted(e.target.checked)} />
                    Show deleted
                  </label>
                )}
                {!readOnly && <Button type="button" variant="ghost" onClick={addLine}><Plus size={14} />Add Line</Button>}
              </div>
            </div>
            <div className="overflow-x-auto bg-white border border-gray-200 rounded-lg">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    <th className="px-3 py-2 text-left font-semibold text-gray-600 w-12">Line</th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-600 min-w-[220px]">Article (Category · Item · Variant)</th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-600 w-24">Qty</th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-600 w-16">UM</th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-600 w-24">Rate</th>
                    {!readOnly && <th className="px-3 py-2 w-10" />}
                    {!isNew && (
                      <>
                        <th className="px-3 py-2 text-left font-semibold text-gray-600 w-20 border-l-2 border-gray-200">Pending</th>
                        <th className="px-3 py-2 text-left font-semibold text-gray-600 w-32">Status</th>
                        <th className="px-3 py-2 text-left font-semibold text-gray-600 w-20">Short</th>
                        <th className="px-3 py-2 w-10">History</th>
                        {/* Asterisks mark the fields a receipt cannot be saved
                            without. Received Rate and Checked By were already
                            mandatory server-side but carried no marker. */}
                        <th className="px-3 py-2 text-left font-semibold text-gray-600 w-24">Received Qty <span className="text-red-500">*</span></th>
                        <th className="px-3 py-2 text-left font-semibold text-gray-600 w-24">Received Rate <span className="text-red-500">*</span></th>
                        <th className="px-3 py-2 text-left font-semibold text-gray-600 w-28">Bill No <span className="text-red-500">*</span></th>
                        <th className="px-3 py-2 text-left font-semibold text-gray-600 w-28">Incoming No</th>
                        <th className="px-3 py-2 text-left font-semibold text-gray-600 w-36">Checked By <span className="text-red-500">*</span></th>
                        <th className="px-3 py-2 text-left font-semibold text-gray-600 w-28">Updated By</th>
                        <th className="px-3 py-2 text-left font-semibold text-gray-600 w-36">Updated Timestamp</th>
                        <th className="px-3 py-2 text-left font-semibold text-gray-600 w-20">Actions</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    let activeCounter = 0;
                    return visibleLines.map((l) => {
                      const displayNo = l.deleted_at ? null : ++activeCounter;
                      const status = l.deleted_at ? null : computeLineStatus(l);
                      const receipts = (l.receipts || []).filter(r => showDeleted || !r.deleted_at);
                      // A fully accounted-for line takes no further receipts —
                      // raise its Qty first if a vendor genuinely over-delivers.
                      const lineClosed = !l.deleted_at && computeLineStatus(l) === 'Closed';
                      const canAdd = !!l.id && !readOnly && !l.deleted_at && !lineClosed;
                      const rowCount = Math.max(receipts.length + (canAdd ? 1 : 0), 1);

                      return Array.from({ length: rowCount }).map((_, rIdx) => {
                        const receipt = receipts[rIdx];
                        const isAddRow = canAdd && rIdx === receipts.length;
                        return (
                          <tr key={`${l._key}-${rIdx}`} className={`border-b border-gray-100 ${l.deleted_at ? 'opacity-50' : ''}`}>
                            {rIdx === 0 && (
                              <>
                                <td rowSpan={rowCount} className="px-3 py-2 text-gray-700 align-top">{displayNo ?? '—'}</td>
                                <td rowSpan={rowCount} className="px-3 py-2 align-top">
                                  <select
                                    value={l.mapping}
                                    onChange={e => pickMapping(l._key, e.target.value)}
                                    disabled={readOnly || !po.vendor_id || !!l.deleted_at}
                                    className={cellCls}
                                  >
                                    <option value="">{po.vendor_id ? 'Select article...' : 'Select vendor first'}</option>
                                    {mappingOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                                  </select>
                                </td>
                                <td rowSpan={rowCount} className="px-3 py-2 align-top">
                                  <input type="number" min={0.01} step="0.01" value={l.qty} onChange={e => setLine(l._key, { qty: e.target.value })} disabled={readOnly || !!l.deleted_at} className={cellCls} />
                                </td>
                                <td rowSpan={rowCount} className="px-3 py-2 align-top text-gray-600">{l.unit_metric || '—'}</td>
                                <td rowSpan={rowCount} className="px-3 py-2 align-top">
                                  <input type="number" min={0} step="0.01" value={l.rate} onChange={e => setLine(l._key, { rate: e.target.value })} disabled={readOnly || !!l.deleted_at} className={cellCls} />
                                </td>
                                {!readOnly && (
                                  <td rowSpan={rowCount} className="px-3 py-2 align-top">
                                    {!l.deleted_at && (
                                      <button
                                        type="button"
                                        onClick={() => removeLine(l._key)}
                                        disabled={activeLines.length === 1}
                                        title="Remove line"
                                        className="p-1.5 rounded hover:bg-red-50 text-red-500 disabled:opacity-30 disabled:hover:bg-transparent"
                                      >
                                        <Trash2 size={14} />
                                      </button>
                                    )}
                                  </td>
                                )}
                              </>
                            )}
                            {!isNew && (
                              <>
                                {rIdx === 0 && (
                                  <>
                                    <td rowSpan={rowCount} className={`px-3 py-2 font-semibold align-top border-l-2 border-gray-200 ${pendingOf(l) > 0 ? 'text-amber-700' : 'text-gray-700'}`}>
                                      {l.deleted_at ? '—' : pendingOf(l)}
                                    </td>
                                    <td rowSpan={rowCount} className="px-3 py-2 align-top">
                                      {l.deleted_at ? <Badge color="gray">Deleted</Badge> : <Badge color={STATUS_COLORS[status] || 'gray'}>{status}</Badge>}
                                      {!l.deleted_at && !!(l.flags || []).length && (
                                        <div className="flex flex-wrap gap-1 mt-1">
                                          {l.flags.map(k => (
                                            <Badge key={k} color={FLAG_META[k]?.color || 'gray'}>{FLAG_META[k]?.short || k}</Badge>
                                          ))}
                                        </div>
                                      )}
                                    </td>
                                    <td rowSpan={rowCount} className="px-3 py-2 align-top">
                                      <div className="flex items-center gap-1">
                                        <input
                                          type="number" min={0} step="0.01"
                                          value={shortDrafts[l._key] ?? l.short}
                                          onChange={e => setShortDrafts(d => ({ ...d, [l._key]: e.target.value }))}
                                          disabled={readOnly || !!l.deleted_at}
                                          className={cellCls}
                                        />
                                        {shortDrafts[l._key] !== undefined && Number(shortDrafts[l._key]) !== l.short && (
                                          <button type="button" onClick={() => saveShort(l)} disabled={savingShortKey === l._key} title="Save Short" className="p-1 rounded hover:bg-green-50 text-green-600 disabled:opacity-40">
                                            <Save size={13} />
                                          </button>
                                        )}
                                      </div>
                                    </td>
                                    <td rowSpan={rowCount} className="px-3 py-2 align-top">
                                      {l.id && <HistoryButton entityType="outbound_po_line" entityId={l.id} title={`Line ${displayNo ?? ''} history`} />}
                                    </td>
                                  </>
                                )}
                                {receipt ? (
                                  <>
                                    <td className={`px-3 py-2 ${receipt.deleted_at ? 'opacity-50' : ''}`}>
                                      <input
                                        type="number" min={0.01} step="0.01"
                                        value={receiptValue(receipt, 'received_qty')}
                                        onChange={e => setReceiptField(receipt, 'received_qty', e.target.value)}
                                        disabled={readOnly || !!receipt.deleted_at}
                                        className={cellCls}
                                      />
                                    </td>
                                    <td className={`px-3 py-2 ${receipt.deleted_at ? 'opacity-50' : ''}`}>
                                      <input
                                        type="number" min={0} step="0.01"
                                        value={receiptValue(receipt, 'received_rate')}
                                        onChange={e => setReceiptField(receipt, 'received_rate', e.target.value)}
                                        disabled={readOnly || !!receipt.deleted_at}
                                        title={(receipt.flags || []).includes('rate_mismatch') ? `${FLAG_META.rate_mismatch.hint} (agreed ${l.rate})` : undefined}
                                        className={`${cellCls} ${(receipt.flags || []).includes('rate_mismatch') ? 'ring-1 ring-red-400 border-red-400' : ''}`}
                                      />
                                    </td>
                                    <td className={`px-3 py-2 ${receipt.deleted_at ? 'opacity-50' : ''}`}>
                                      <input
                                        type="text"
                                        value={receiptValue(receipt, 'bill_no')}
                                        onChange={e => setReceiptField(receipt, 'bill_no', e.target.value)}
                                        disabled={readOnly || !!receipt.deleted_at}
                                        className={cellCls}
                                      />
                                    </td>
                                    <td className={`px-3 py-2 ${receipt.deleted_at ? 'opacity-50' : ''}`}>
                                      <input
                                        type="number" min={1} step="1"
                                        value={receiptValue(receipt, 'incoming_no')}
                                        onChange={e => setReceiptField(receipt, 'incoming_no', e.target.value)}
                                        disabled={readOnly || !!receipt.deleted_at}
                                        title={(receipt.flags || []).includes('missing_incoming_no') ? FLAG_META.missing_incoming_no.hint : undefined}
                                        className={`${cellCls} ${(receipt.flags || []).includes('missing_incoming_no') ? 'ring-1 ring-amber-400 border-amber-400' : ''}`}
                                      />
                                    </td>
                                    <td className={`px-3 py-2 ${receipt.deleted_at ? 'opacity-50' : ''}`}>
                                      <select
                                        value={receiptValue(receipt, 'checked_by') || ''}
                                        onChange={e => setReceiptField(receipt, 'checked_by', e.target.value)}
                                        disabled={readOnly || !!receipt.deleted_at}
                                        className={cellCls}
                                      >
                                        <option value="">Select...</option>
                                        {checkerOptionsFor(receipt.checked_by, receipt.checked_by_name).map(o => (
                                          <option key={o.value} value={o.value}>{o.label}</option>
                                        ))}
                                      </select>
                                    </td>
                                    <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{receipt.updated_by_name || receipt.created_by_name || '—'}</td>
                                    <td className="px-3 py-2 text-xs text-gray-500 whitespace-nowrap">{formatDateTime(receipt.updated_at)}</td>
                                    <td className="px-3 py-2">
                                      <div className="flex items-center gap-1">
                                        {!receipt.deleted_at && !readOnly && (
                                          <>
                                            {receiptDrafts[receipt.id] && (
                                              <button type="button" onClick={() => saveReceipt(l, receipt)} disabled={savingReceiptId === receipt.id} title="Save receipt" className="p-1 rounded hover:bg-green-50 text-green-600 disabled:opacity-40">
                                                <Save size={13} />
                                              </button>
                                            )}
                                            <button type="button" onClick={() => setConfirmDeleteReceipt({ id: receipt.id, lineId: l.id })} title="Delete receipt" className="p-1 rounded hover:bg-red-50 text-red-500">
                                              <Trash2 size={13} />
                                            </button>
                                          </>
                                        )}
                                        {receipt.deleted_at && !readOnly && (
                                          <button type="button" onClick={() => handleRestoreReceipt(l, receipt)} disabled={restoringReceiptId === receipt.id} title="Restore receipt" className="p-1 rounded hover:bg-green-50 text-green-600 disabled:opacity-40">
                                            <RotateCcw size={13} />
                                          </button>
                                        )}
                                      </div>
                                    </td>
                                  </>
                                ) : isAddRow ? (
                                  addingReceiptFor === l._key ? (
                                    <>
                                      <td className="px-3 py-2">
                                        <input type="number" min={0.01} step="0.01" placeholder="Qty" value={newReceipt.received_qty} onChange={e => setNewReceipt(r => ({ ...r, received_qty: e.target.value }))} className={cellCls} />
                                      </td>
                                      <td className="px-3 py-2">
                                        <input type="number" min={0} step="0.01" placeholder="Rate" value={newReceipt.received_rate} onChange={e => setNewReceipt(r => ({ ...r, received_rate: e.target.value }))} className={cellCls} />
                                      </td>
                                      <td className="px-3 py-2">
                                        <input type="text" placeholder="Bill No" value={newReceipt.bill_no} onChange={e => setNewReceipt(r => ({ ...r, bill_no: e.target.value }))} className={cellCls} />
                                      </td>
                                      <td className="px-3 py-2">
                                        <input type="number" min={1} step="1" placeholder="Incoming" value={newReceipt.incoming_no} onChange={e => setNewReceipt(r => ({ ...r, incoming_no: e.target.value }))} className={cellCls} />
                                      </td>
                                      <td className="px-3 py-2">
                                        <select value={newReceipt.checked_by} onChange={e => setNewReceipt(r => ({ ...r, checked_by: e.target.value }))} className={cellCls}>
                                          <option value="">Checked by...</option>
                                          {checkerOptionsFor().map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                                        </select>
                                      </td>
                                      <td colSpan={2} className="px-3 py-2 text-xs text-gray-400">New receipt</td>
                                      <td className="px-3 py-2">
                                        <div className="flex items-center gap-1">
                                          <button type="button" onClick={() => saveNewReceipt(l)} disabled={savingNewReceipt} title="Add receipt" className="p-1 rounded hover:bg-green-50 text-green-600 disabled:opacity-40">
                                            <Save size={13} />
                                          </button>
                                          <button type="button" onClick={() => setAddingReceiptFor(null)} title="Cancel" className="p-1 rounded hover:bg-gray-100 text-gray-400">
                                            <X size={13} />
                                          </button>
                                        </div>
                                      </td>
                                    </>
                                  ) : (
                                    <td colSpan={8} className="px-3 py-2">
                                      <button type="button" onClick={() => startAddReceipt(l._key)} className="inline-flex items-center gap-1 text-xs text-[#c1121f] hover:underline">
                                        <Plus size={12} />Add receipt
                                      </button>
                                    </td>
                                  )
                                ) : (
                                  <td colSpan={8} className="px-3 py-2 text-xs text-gray-400">
                                    {l.deleted_at ? '—'
                                      : lineClosed ? 'Line is Closed — increase Qty to receive more'
                                      : l.id ? 'No receipts yet' : 'Save the PO to add receipts'}
                                  </td>
                                )}
                              </>
                            )}
                          </tr>
                        );
                      });
                    });
                  })()}
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

      <ConfirmDialog
        isOpen={!!confirmDeleteReceipt}
        onClose={() => setConfirmDeleteReceipt(null)}
        onConfirm={handleDeleteReceipt}
        title="Delete Receipt"
        message="Delete this receipt entry? It will be hidden but can be restored from the Show Deleted view."
        confirmLabel="Delete"
        loading={deletingReceipt}
      />
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
