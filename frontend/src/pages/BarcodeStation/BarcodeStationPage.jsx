import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import {
  Lock, Search, X, Pencil, Trash2, Printer, Eye, UserRound, Plus, Sparkles, ShieldCheck, Tag, ClipboardCheck,
} from 'lucide-react';
import Button from '../../components/ui/Button';
import Modal from '../../components/ui/Modal';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import Pagination, { loadPersistedPageSize, persistPageSize } from '../../components/ui/Pagination';
import PinScreen from './PinScreen';
import BatchEditModal, { BatchFields } from './BatchEditModal';
import KeysModal from './KeysModal';
import PrintLabelsModal from './PrintLabelsModal';
import PrintPortal from './PrintPortal';
import StockCountPanel from './StockCountPanel';
import { fieldsOf, inputCls, openPrintSheet } from './stationHelpers';
import {
  getStationToken, getOperator, setOperator, onStationSignedOut, endStationSession,
  getStationOptions, listLabelBatches, createLabelBatch, deleteLabelBatch, generateLabelBatch, findLabelKey,
} from '../../api/station.api';
import { listLabelBatchesAdmin } from '../../api/labelBatches.api';
import { useAuth } from '../../context/AuthContext';
import { useRBAC } from '../../hooks/useRBAC';
import {
  batchFieldsError, operatorError, keyError, normOperator, articleLabel, packSizeLabel, keyCountLabel, printCountLabel,
} from '../../utils/barcodeStation';
import { formatDateTime } from '../../utils/formatters';
import { sortByText } from '../../utils/sort';

// The public Barcode Station (migration 098) -- reached WITHOUT a portal login.
// A device unlocks it once with the shared PIN; the operator types their name.
// Each delivery becomes a batch: saved as a draft (editable, deletable), then
// Generate gives every sticker its own random 8-digit key and the batch is
// FINAL -- never edited or deleted again.
//
// ONLY ADMINS SEE KEYS (client's rule). Everyone else gets "N keys · printed
// N×" and a Print button that sends the stickers to the printer off-screen
// (PrintPortal) -- no keys, no preview. When this browser is also logged into
// the portal as Admin/Owner (useRBAC), the same page shows the keys, the key
// list and a print preview, all fetched from the Admin API -- which checks the
// role server-side, so editing localStorage reveals nothing. Admins only use
// their own machines, never the warehouse PC.
//
// No AppShell (that is the logged-in shell), no HistoryButton (it calls the
// portal API). Station calls go through api/station.api.js; only the Admin view
// uses the shared portal instance (api/labelBatches.api.js).

const PAGE_SIZE_KEY = 'barcodeStation.batches';
const defaultFilters = () => ({ vendor_id: '', floor_id: '', date_from: '', date_to: '' });

// Two jobs on one station: labelling incoming stock, and the daily stock count
// (migration 102). Remembered per device -- the counting phone stays on Count.
const MODE_KEY = 'roms:barcodeStation:mode';
const MODES = [
  { key: 'label', label: 'Label stock', Icon: Tag },
  { key: 'count', label: 'Stock count', Icon: ClipboardCheck },
];
function readMode() {
  try { return localStorage.getItem(MODE_KEY) === 'count' ? 'count' : 'label'; } catch { return 'label'; }
}
function writeMode(mode) {
  try { localStorage.setItem(MODE_KEY, mode); } catch { /* storage unavailable */ }
}

export default function BarcodeStationPage() {
  const [signedIn, setSignedIn] = useState(() => !!getStationToken());
  const [operator, setOperatorState] = useState(() => getOperator());
  const [note, setNote] = useState('');
  const { user, loading: authLoading } = useAuth();
  const { isAdmin } = useRBAC();

  useEffect(() => onStationSignedOut((body) => {
    setNote(body?.message || '');
    setSignedIn(false);
  }), []);

  if (!signedIn || !operator) {
    return (
      <PinScreen
        needsPin={!signedIn}
        initialOperator={operator}
        note={note}
        onDone={(name) => {
          setOperator(name);
          setOperatorState(name);
          setNote('');
          setSignedIn(true);
        }}
      />
    );
  }

  // Wait for the portal session to be read, so the first fetch already goes to
  // the right list (Admin or station).
  if (authLoading) return null;

  return (
    <Station
      key={isAdmin ? 'admin' : 'staff'}
      operator={operator}
      isAdmin={isAdmin}
      adminName={user?.name || user?.username}
      onOperatorChange={(name) => { setOperator(name); setOperatorState(name); }}
      onLock={() => { endStationSession(); setNote(''); setSignedIn(false); }}
    />
  );
}

function Station({ operator, isAdmin, adminName, onOperatorChange, onLock }) {
  const [options, setOptions] = useState(null);
  const [mode, setModeState] = useState(readMode);
  const setMode = (m) => { setModeState(m); writeMode(m); };

  const [entry, setEntry] = useState(() => fieldsOf(null));
  const [entryError, setEntryError] = useState('');
  const [saving, setSaving] = useState(false);

  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(() => loadPersistedPageSize(PAGE_SIZE_KEY, 25));
  const [draftFilters, setDraftFilters] = useState(defaultFilters);
  const [filters, setFilters] = useState(defaultFilters);

  const [keyQuery, setKeyQuery] = useState('');
  const [keyHit, setKeyHit] = useState(null);

  const [editing, setEditing] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [printing, setPrinting] = useState(null);
  const [printJob, setPrintJob] = useState(null);
  const [confirmGenerate, setConfirmGenerate] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);

  useEffect(() => {
    getStationOptions()
      .then(setOptions)
      .catch((err) => { if (err.response?.status !== 401) toast.error(err.response?.data?.message || 'Could not load vendors and floors'); });
  }, []);

  const buildParams = useCallback((o = {}) => {
    const f = o.filters ?? filters;
    const focus = o.focusId !== undefined ? o.focusId : keyHit?.batch.id;
    const params = { page: o.page ?? page, page_size: o.pageSize ?? pageSize };
    if (focus) params.id = focus;
    else {
      for (const k of ['vendor_id', 'floor_id', 'date_from', 'date_to']) if (f[k]) params[k] = f[k];
    }
    return params;
  }, [filters, keyHit, page, pageSize]);

  // State is only set in the promise callbacks, so the mount effect can call
  // this directly; `load` adds the synchronous loading flag for later fetches.
  // An Admin's list (with key previews) comes from the Admin API.
  const fetchRows = useCallback((o = {}) => (isAdmin ? listLabelBatchesAdmin : listLabelBatches)(buildParams(o))
    .then((res) => { setRows(res.rows); setTotal(res.total); })
    .catch((err) => { if (err.response?.status !== 401) toast.error(err.response?.data?.message || 'Could not load batches'); })
    .finally(() => setLoading(false)), [buildParams, isAdmin]);

  const load = (o = {}) => {
    setLoading(true);
    return fetchRows(o);
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { fetchRows(); }, []);

  const toastError = (err, fallback) => {
    if (err.response?.status === 401) return;
    toast.error(err.response?.data?.message || fallback);
  };

  // ---- add an entry ----------------------------------------------------
  const saveEntry = async (e) => {
    e.preventDefault();
    const err = batchFieldsError(entry);
    if (err) { setEntryError(err); return; }
    setEntryError('');
    setSaving(true);
    try {
      const created = await createLabelBatch({ ...entry, operator });
      toast.success(`Batch #${created.id} saved — press Generate when it is right`);
      // Keep vendor and floor: the next entry is usually the same delivery.
      setEntry({ ...fieldsOf(null), outbound_vendor_id: entry.outbound_vendor_id, floor_id: entry.floor_id });
      setKeyHit(null);
      setPage(1);
      load({ page: 1, focusId: null });
    } catch (ex) {
      const status = ex.response?.status;
      if (status === 400 || status === 409) setEntryError(ex.response.data.message);
      else toastError(ex, 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  // ---- filters & key search ---------------------------------------------
  const applyFilters = (e) => {
    e?.preventDefault();
    setFilters(draftFilters);
    setKeyHit(null);
    setPage(1);
    load({ filters: draftFilters, page: 1, focusId: null });
  };
  const clearFilters = () => {
    const blank = defaultFilters();
    setDraftFilters(blank);
    setFilters(blank);
    setKeyHit(null);
    setPage(1);
    load({ filters: blank, page: 1, focusId: null });
  };

  const searchKey = async (e) => {
    e.preventDefault();
    const raw = keyQuery.trim();
    const err = keyError(raw);
    if (err) { toast.error(err); return; }
    try {
      const hit = await findLabelKey(raw);
      setKeyHit(hit);
      setPage(1);
      load({ page: 1, focusId: hit.batch.id });
    } catch (ex) {
      toastError(ex, 'Key search failed');
    }
  };
  const clearKeyHit = () => {
    setKeyHit(null);
    setKeyQuery('');
    setPage(1);
    load({ page: 1, focusId: null });
  };

  // ---- row actions -------------------------------------------------------
  const doGenerate = async () => {
    const b = confirmGenerate;
    setBusy(true);
    try {
      const done = await generateLabelBatch(b.id, operator);
      toast.success(`${keyCountLabel(done.key_count)} generated for batch #${b.id}`);
      setConfirmGenerate(null);
      load();
    } catch (ex) {
      toastError(ex, 'Generate failed');
      if (ex.response?.status === 409) { setConfirmGenerate(null); load(); }
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async () => {
    const b = confirmDelete;
    setBusy(true);
    try {
      await deleteLabelBatch(b.id, operator);
      toast.success(`Draft batch #${b.id} deleted`);
      setConfirmDelete(null);
      load();
    } catch (ex) {
      toastError(ex, 'Delete failed');
      // Generated meanwhile: it is final now, so show it as it is.
      if (ex.response?.status === 409) { setConfirmDelete(null); load(); }
    } finally {
      setBusy(false);
    }
  };

  // The print was logged and the keys are in hand: close the modal and let
  // PrintPortal send the stickers to the printer, off-screen.
  const startPrint = (job) => {
    setPrinting(null);
    setPrintJob(job);
  };
  const printDone = () => {
    const n = printJob?.labels.length || 0;
    toast.success(`${n} label${n !== 1 ? 's' : ''} sent to print`);
    setPrintJob(null);
    load();
  };
  const printMode = options?.print_mode || 'dialog';

  const vendorsSorted = sortByText(options?.vendors || [], (v) => v.name);
  const floorsSorted = sortByText(options?.floors || [], (f) => f.name);
  const COLS = 9;

  return (
    <div className="min-h-screen bg-[#fdf0d5]">
      <header className="bg-white border-b border-[#003049]/10 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 py-3 flex flex-wrap items-center gap-3">
          <img src="/logo-wordmark.png" alt="Royal Mart" className="h-9 w-auto object-contain rounded" />
          <div className="mr-auto">
            <h1 className="text-lg font-bold text-[#003049] leading-tight">Barcode Station</h1>
            <p className="text-xs text-gray-500">{mode === 'count' ? 'Daily stock count' : 'Label incoming stock'}</p>
          </div>

          {/* Full width on a phone (its own row), inline from sm up. */}
          <div className="order-last w-full sm:order-none sm:w-auto flex rounded-lg bg-[#003049]/5 p-1" role="tablist">
            {MODES.map((m) => {
              const ModeIcon = m.Icon;
              return (
                <button
                  key={m.key}
                  type="button"
                  role="tab"
                  aria-selected={mode === m.key}
                  onClick={() => setMode(m.key)}
                  className={`flex-1 sm:flex-none flex items-center justify-center gap-1.5 rounded-md px-3 min-h-[40px] text-sm font-medium transition-colors ${
                    mode === m.key ? 'bg-white text-[#c1121f] shadow-sm' : 'text-[#003049] hover:bg-white/60'
                  }`}
                >
                  <ModeIcon size={15} /> {m.label}
                </button>
              );
            })}
          </div>

          {mode === 'label' && (
          <form onSubmit={searchKey} className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              value={keyQuery}
              onChange={(e) => setKeyQuery(e.target.value.replace(/\D/g, '').slice(0, 8))}
              inputMode="numeric"
              placeholder="Scan or type a key"
              className="w-56 pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30"
            />
          </form>
          )}

          <button
            type="button"
            onClick={() => setRenaming(true)}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#003049]/5 text-sm text-[#003049] hover:bg-[#003049]/10"
            title="Change operator"
          >
            <UserRound size={15} /> {operator}
          </button>
          <Button variant="ghost" onClick={onLock} title="Lock this station — the PIN is needed again">
            <Lock size={15} /> Lock
          </Button>
        </div>
        {isAdmin && (
          <div className="bg-[#003049] text-white text-xs">
            <div className="max-w-7xl mx-auto px-4 py-1.5 flex items-center gap-2">
              <ShieldCheck size={14} />
              Admin view — signed in to the portal as {adminName}. Barcode keys are visible on this screen.
            </div>
          </div>
        )}
      </header>

      <main className="max-w-7xl mx-auto px-4 py-5 space-y-5">
        {mode === 'count' && <StockCountPanel operator={operator} floors={floorsSorted} />}

        {mode === 'label' && (<>
        {/* ---- New entry ---- */}
        <section className="bg-white rounded-xl border border-gray-200 p-4">
          <h2 className="text-sm font-semibold text-[#003049] mb-3 flex items-center gap-2">
            <Plus size={16} /> New entry
          </h2>
          <form onSubmit={saveEntry} noValidate>
            <BatchFields value={entry} onChange={(v) => { setEntry(v); setEntryError(''); }} options={options} />
            <div className="flex flex-wrap items-center justify-between gap-3 mt-3">
              <p className={`text-sm ${entryError ? 'text-[#c1121f]' : 'text-gray-500'}`}>
                {entryError || 'Save the entry, check it, then press Generate to create its keys.'}
              </p>
              <Button type="submit" loading={saving} disabled={!options}>Save entry</Button>
            </div>
          </form>
        </section>

        {/* ---- Batches ---- */}
        <section className="bg-white rounded-xl border border-gray-200">
          <form onSubmit={applyFilters} className="flex flex-wrap items-end gap-3 p-4 border-b border-gray-100">
            <label className="block w-48">
              <span className="block text-xs font-medium text-gray-600 mb-1">Vendor</span>
              <select value={draftFilters.vendor_id} onChange={(e) => setDraftFilters((f) => ({ ...f, vendor_id: e.target.value }))} className={inputCls}>
                <option value="">All vendors</option>
                {vendorsSorted.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            </label>
            <label className="block w-40">
              <span className="block text-xs font-medium text-gray-600 mb-1">Floor</span>
              <select value={draftFilters.floor_id} onChange={(e) => setDraftFilters((f) => ({ ...f, floor_id: e.target.value }))} className={inputCls}>
                <option value="">All floors</option>
                {floorsSorted.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </label>
            <label className="block w-40">
              <span className="block text-xs font-medium text-gray-600 mb-1">Incoming from</span>
              <input type="date" value={draftFilters.date_from} onChange={(e) => setDraftFilters((f) => ({ ...f, date_from: e.target.value }))} className={inputCls} />
            </label>
            <label className="block w-40">
              <span className="block text-xs font-medium text-gray-600 mb-1">Incoming to</span>
              <input type="date" value={draftFilters.date_to} onChange={(e) => setDraftFilters((f) => ({ ...f, date_to: e.target.value }))} className={inputCls} />
            </label>
            <Button type="submit" variant="secondary">Search</Button>
            <Button type="button" variant="ghost" onClick={clearFilters}>Clear</Button>
          </form>

          {keyHit && (
            <div className="mx-4 mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-[#c1121f]/30 bg-red-50 px-3 py-2 text-sm">
              <span className="text-[#003049]">
                Key <span className="font-mono font-semibold">{keyHit.label_key}</span> → batch #{keyHit.batch.id}, label {keyHit.label_no} of {keyHit.batch.label_count}
              </span>
              {isAdmin && (
                <button type="button" onClick={() => setViewing({ batch: keyHit.batch, highlightKey: keyHit.label_key })} className="text-[#c1121f] font-medium hover:underline">
                  Show in keys
                </button>
              )}
              <button type="button" onClick={clearKeyHit} className="ml-auto flex items-center gap-1 text-gray-500 hover:text-gray-700">
                <X size={14} /> Show all batches
              </button>
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 bg-gray-50 text-left text-xs font-semibold text-gray-600 uppercase tracking-wide">
                <tr>
                  <th className="px-4 py-3">Batch</th>
                  <th className="px-4 py-3">Vendor Name</th>
                  <th className="px-4 py-3">Article</th>
                  <th className="px-4 py-3 text-right">Pack Size</th>
                  <th className="px-4 py-3">Floor</th>
                  <th className="px-4 py-3 text-right">No. of Barcodes</th>
                  <th className="px-4 py-3">Key</th>
                  <th className="px-4 py-3">Date of Incoming</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading && Array.from({ length: 4 }).map((_, i) => (
                  <tr key={`sk-${i}`} className="border-b border-gray-100">
                    {Array.from({ length: COLS }).map((__, j) => (
                      <td key={j} className="px-4 py-3"><div className="h-4 bg-gray-100 rounded animate-pulse" /></td>
                    ))}
                  </tr>
                ))}
                {!loading && rows.map((b) => (
                  <tr key={b.id} className={`border-b border-gray-100 hover:bg-gray-50 align-top ${keyHit?.batch.id === b.id ? 'bg-red-50/40' : ''}`}>
                    <td className="px-4 py-3 text-gray-500 tabular-nums">#{b.id}</td>
                    <td className="px-4 py-3 font-medium text-[#003049]">{b.vendor_name}</td>
                    <td className="px-4 py-3 text-gray-700">{articleLabel(b)}</td>
                    <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap">{packSizeLabel(b)}</td>
                    <td className="px-4 py-3 whitespace-nowrap">{b.floor_name}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{b.label_count}</td>
                    <td className="px-4 py-3">
                      {b.is_generated && isAdmin && (
                        <div className="min-w-[200px]">
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-[#003049]">{keyCountLabel(b.key_count)}</span>
                            <button type="button" onClick={() => setViewing({ batch: b })} className="inline-flex items-center gap-1 text-xs font-medium text-[#003049] hover:underline">
                              <Eye size={13} /> View
                            </button>
                            <button type="button" onClick={() => openPrintSheet(b.id)} className="inline-flex items-center gap-1 text-xs font-medium text-[#c1121f] hover:underline" title="Preview and print (Admin)">
                              <Printer size={13} /> Print
                            </button>
                          </div>
                          <p className="font-mono text-xs text-gray-500 mt-0.5">
                            {(b.key_preview || []).join(', ')}{b.key_count > (b.key_preview || []).length ? ', …' : ''}
                          </p>
                          <p className="text-xs text-gray-400">{printCountLabel(b.print_count)}</p>
                        </div>
                      )}
                      {b.is_generated && !isAdmin && (
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 min-w-[200px]">
                          <span className="text-[#003049]">
                            <span className="font-semibold">{keyCountLabel(b.key_count)}</span>
                            <span className="text-xs text-gray-500"> · {printCountLabel(b.print_count)}</span>
                          </span>
                          <Button size="sm" variant="secondary" onClick={() => setPrinting(b)}>
                            <Printer size={14} /> Print
                          </Button>
                        </div>
                      )}
                      {!b.is_generated && (
                        <Button size="sm" onClick={() => setConfirmGenerate(b)}>
                          <Sparkles size={14} /> Generate
                        </Button>
                      )}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-gray-600">
                      {b.is_generated ? formatDateTime(b.generated_at) : <span className="text-gray-400 italic">Draft</span>}
                    </td>
                    <td className="px-4 py-3">
                      {/* Only a draft can change. A generated entry is final. */}
                      {!b.is_generated && (
                        <div className="flex justify-end gap-1">
                          <button type="button" onClick={() => setEditing(b)} className="p-1.5 rounded-lg text-blue-600 hover:bg-blue-50" title="Edit draft">
                            <Pencil size={15} />
                          </button>
                          <button type="button" onClick={() => setConfirmDelete(b)} className="p-1.5 rounded-lg text-red-600 hover:bg-red-50" title="Delete draft">
                            <Trash2 size={15} />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!loading && !rows.length && (
              <p className="text-center text-sm text-gray-500 py-10">No batches match the current filters.</p>
            )}
          </div>

          <Pagination
            page={page}
            pageSize={pageSize}
            total={total}
            onPageChange={(p) => { setPage(p); load({ page: p }); }}
            onPageSizeChange={(s) => { setPageSize(s); persistPageSize(PAGE_SIZE_KEY, s); setPage(1); load({ page: 1, pageSize: s }); }}
          />
        </section>
        </>)}
      </main>

      {editing && (
        <BatchEditModal
          batch={editing}
          options={options}
          operator={operator}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
      {/* Admin only: the key list. Never rendered for anyone else. */}
      {isAdmin && viewing && <KeysModal batch={viewing.batch} highlightKey={viewing.highlightKey} onClose={() => setViewing(null)} />}
      {printing && (
        <PrintLabelsModal
          batch={printing}
          operator={operator}
          printMode={printMode}
          onClose={() => setPrinting(null)}
          onJob={startPrint}
        />
      )}
      <PrintPortal job={printJob} onDone={printDone} />
      {renaming && (
        <OperatorModal
          current={operator}
          onClose={() => setRenaming(false)}
          onSave={(name) => { onOperatorChange(name); setRenaming(false); }}
        />
      )}

      <ConfirmDialog
        isOpen={!!confirmGenerate}
        onClose={() => setConfirmGenerate(null)}
        onConfirm={doGenerate}
        loading={busy}
        title="Generate keys?"
        confirmLabel={confirmGenerate ? `Generate ${keyCountLabel(confirmGenerate.label_count)}` : 'Generate'}
        message={confirmGenerate
          ? `${confirmGenerate.vendor_name} · ${articleLabel(confirmGenerate)} · pack of ${packSizeLabel(confirmGenerate)} · ${confirmGenerate.floor_name}. After this the entry is final — it can never be edited or deleted.`
          : ''}
      />
      <ConfirmDialog
        isOpen={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        onConfirm={doDelete}
        loading={busy}
        title="Delete draft?"
        confirmLabel="Delete"
        message={confirmDelete ? `Delete draft batch #${confirmDelete.id} (${confirmDelete.vendor_name}, ${confirmDelete.label_count} labels)? It has no keys yet.` : ''}
      />
    </div>
  );
}

function OperatorModal({ current, onClose, onSave }) {
  const [name, setName] = useState(current);
  const [error, setError] = useState('');
  const save = (e) => {
    e.preventDefault();
    const err = operatorError(name);
    if (err) { setError(err); return; }
    onSave(normOperator(name));
  };
  return (
    <Modal isOpen onClose={onClose} title="Who is using this PC?" size="sm">
      <form onSubmit={save} className="space-y-4" noValidate>
        <label className="block">
          <span className="block text-xs font-medium text-gray-600 mb-1">Your name</span>
          <input autoFocus value={name} onChange={(e) => { setName(e.target.value); setError(''); }} className={inputCls} />
        </label>
        <p className="text-xs text-gray-500">Your name goes on every entry you save or generate from now on.</p>
        {error && <p className="text-sm text-[#c1121f]">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit">Save</Button>
        </div>
      </form>
    </Modal>
  );
}
