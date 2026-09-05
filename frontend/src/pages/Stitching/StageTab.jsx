import { Fragment, useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Link } from 'react-router-dom';
import * as XLSX from 'xlsx';
import { Plus, Trash2, ExternalLink, Route, PackageCheck, RotateCcw, Undo2, Download } from 'lucide-react';
import Badge from '../../components/ui/Badge';
import Button from '../../components/ui/Button';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import Pagination, { loadPersistedPageSize, persistPageSize } from '../../components/ui/Pagination';
import { HistoryButton } from '../../components/shared/HistoryDrawer';
import { useSessionState } from '../../hooks/useSessionState';
import {
  listStitchingLots, listStitchingStageCounts, deleteStitchingLot,
  closeStitchingLot, reopenStitchingLot,
} from '../../api/stitching.api';
import { STATUSES, STATUS_COLORS, fmtNum, fmtQty, EPSILON, ALL_TAB } from '../../utils/stitching';
import { formatDateTime } from '../../utils/formatters';
import JourneyModal from './JourneyModal';
import ChallanModal from './ChallanModal';
import ReceiveModal from './ReceiveModal';
import RemoveChallanModal from './RemoveChallanModal';

const inputCls = 'w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f]';
// Density scales with the viewport, matching OutboundPODetail: tight enough for
// a 1366px laptop, roomier on a large monitor.
const thCls = 'px-2 py-2 xl:px-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap';
const tdCls = 'px-2 py-1.5 xl:px-3 xl:py-2';

const EMPTY_FILTERS = {
  party_name: '', incoming_no: '', challan_no: '', po_order_no: '', status: '',
};

// Same shape the other export pages use (OutboundPOList, PackagingList,
// OutboundVendorsPage). `columns` is [{ key, header }]; values come straight off
// the flattened row.
function downloadRows(filename, columns, rows) {
  const header = columns.map(c => c.header);
  const data = rows.map(r => columns.map(c => (r[c.key] == null ? '' : r[c.key])));
  const ws = XLSX.utils.aoa_to_sheet([header, ...data]);
  ws['!cols'] = header.map(() => ({ wch: 18 }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Export');
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
  XLSX.writeFile(wb, `${filename}-${stamp}.xlsx`);
}

// Stage is included even on a single-stage tab: a saved file outlives the tab it
// came from.
const EXPORT_COLUMNS = [
  { key: 'stage', header: 'Stage' },
  { key: 'party_name', header: 'Party Name' },
  { key: 'item_name', header: 'Article' },
  { key: 'variant', header: 'Variant' },
  { key: 'po_order_no', header: 'PO' },
  { key: 'status', header: 'Status' },
  { key: 'metre', header: 'Qty' },
  { key: 'balance', header: 'Balance' },
  { key: 'unit_metric', header: 'Unit' },
  { key: 'rate', header: 'Rate' },
  { key: 'process_rate', header: 'Process Rate' },
  { key: 'after_rate', header: 'After Rate' },
  { key: 'challan_no', header: 'Challan No' },
  { key: 'incoming_no', header: 'Incoming No' },
  { key: 'checked_by_name', header: 'Checked By' },
  { key: 'updated_by_name', header: 'Updated By' },
  { key: 'updated_at', header: 'Updated At' },
];

export default function StageTab({ stage, onOpenCounts }) {
  const pageSizeKey = 'stitching.pageSize';
  const [filters, setFilters] = useSessionState(`stitching.filters.${stage}`, EMPTY_FILTERS);
  // Draft is what the inputs hold; `filters` is what has actually been searched.
  // Text filters apply on Enter or the Search button, never on every keystroke —
  // same convention as the outbound PO list.
  const [draft, setDraft] = useState(filters);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(() => loadPersistedPageSize(pageSizeKey));
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [journeyFor, setJourneyFor] = useState(null);
  const [closing, setClosing] = useState(null);
  const [challanFor, setChallanFor] = useState(null);
  const [receiving, setReceiving] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [busyKey, setBusyKey] = useState(null);
  const [downloading, setDownloading] = useState(false);

  // "All" is a view across every stage, not a stage the server knows about.
  const isAll = stage === ALL_TAB;
  // Stage only earns a column when rows can differ — on a stage tab every row
  // would repeat the tab's own name.
  const COLUMN_COUNT = isAll ? 14 : 13;

  // Params are built once and reused by the export, so what downloads is exactly
  // what the filters describe.
  const buildParams = useCallback(() => {
    // On All the stage key is OMITTED rather than sent empty: the server treats
    // an absent stage as "every stage", but validates one that is present.
    // Chain order matters here and nowhere else — the point of the tab is
    // following one PO from Gray to Packed, which the default updated_at sort
    // interleaves by edit time.
    const params = isAll
      ? { sort_by: 'po_stage', sort_dir: 'asc' }
      : { stage };
    for (const [k, v] of Object.entries(filters)) {
      if (String(v || '').trim()) params[k] = String(v).trim();
    }
    return params;
  }, [isAll, stage, filters]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = { ...buildParams(), page, page_size: pageSize };
      // The badges are scoped by the same filters as the table, so they are
      // fetched alongside it rather than on their own schedule — same split
      // OutboundPOList uses with load() + loadItemCounts().
      const [data, counts] = await Promise.all([
        listStitchingLots(params),
        listStitchingStageCounts(params),
      ]);
      setRows(data.rows || []);
      setTotal(data.total || 0);
      onOpenCounts?.(counts.counts || {});
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not load lots');
      setRows([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [buildParams, page, pageSize, onOpenCounts]);

  useEffect(() => { load(); }, [load]);

  const handleDownload = async () => {
    setDownloading(true);
    try {
      // page_size 'all' is what makes this the whole filtered set rather than
      // the page on screen — the thing that was actually asked for.
      const res = await listStitchingLots({ ...buildParams(), page: 1, page_size: 'all' });
      const exportRows = (res.rows || []).map(r => ({
        stage: r.stage,
        party_name: r.party_name || '',
        item_name: r.item_name || '',
        variant: r.variant || '',
        po_order_no: r.po_order_no || '',
        status: r.status,
        // Numbers stay numbers, with the unit in its own column. A spreadsheet
        // exists to sum this, which "5 pcs" in the cell would prevent.
        metre: r.metre,
        balance: r.balance,
        unit_metric: r.unit_metric || '',
        rate: r.rate,
        process_rate: r.process_rate,
        after_rate: r.after_rate,
        challan_no: r.challan_no || '',
        incoming_no: `${r.incoming_prefix || ''}${r.incoming_no || ''}`,
        checked_by_name: r.checked_by_name || '',
        updated_by_name: r.updated_by_name || '',
        updated_at: r.updated_at || '',
      }));
      downloadRows(`stitching-${String(stage).toLowerCase()}`, EXPORT_COLUMNS, exportRows);
    } catch {
      toast.error('Failed to export');
    } finally { setDownloading(false); }
  };

  const applyFilters = () => { setFilters(draft); setPage(1); };
  const clearFilters = () => { setDraft(EMPTY_FILTERS); setFilters(EMPTY_FILTERS); setPage(1); };
  const onFilterKeyDown = (e) => { if (e.key === 'Enter') applyFilters(); };
  const setDraftField = (k, v) => setDraft(d => ({ ...d, [k]: v }));

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await deleteStitchingLot(confirmDelete.id);
      toast.success('Lot removed');
      setConfirmDelete(null);
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not remove this lot');
    } finally {
      setDeleting(false);
    }
  };

  // Closing is confirmed because it is the record that goods left the building;
  // reopening is not, since it only undoes that and is itself audited.
  const handleClose = async () => {
    setBusyKey(closing.lot_key);
    try {
      await closeStitchingLot(closing.src, closing.id);
      toast.success('Lot closed');
      setClosing(null);
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not close this lot');
    } finally {
      setBusyKey(null);
    }
  };

  const reopen = async (r) => {
    setBusyKey(r.lot_key);
    try {
      await reopenStitchingLot(r.src, r.id);
      toast.success('Lot reopened');
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not reopen this lot');
    } finally {
      setBusyKey(null);
    }
  };

  // Sr is a plain running number within the tab, continuing across pages.
  const srBase = (page - 1) * pageSize;

  return (
    <>
      <div className="bg-white rounded-xl border border-gray-200 p-4 mb-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
          <input placeholder="Party Name" value={draft.party_name} onChange={e => setDraftField('party_name', e.target.value)} onKeyDown={onFilterKeyDown} className={inputCls} />
          <input placeholder="Incoming No" value={draft.incoming_no} onChange={e => setDraftField('incoming_no', e.target.value)} onKeyDown={onFilterKeyDown} className={inputCls} />
          <input placeholder="Challan No" value={draft.challan_no} onChange={e => setDraftField('challan_no', e.target.value)} onKeyDown={onFilterKeyDown} className={inputCls} />
          <input placeholder="PO No" value={draft.po_order_no} onChange={e => setDraftField('po_order_no', e.target.value)} onKeyDown={onFilterKeyDown} className={inputCls} />
          <select value={draft.status} onChange={e => setDraftField('status', e.target.value)} className={inputCls}>
            <option value="">All statuses</option>
            {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div className="flex justify-end gap-2 mt-3">
          {/* Beside Clear/Search so it reads as "act on these filters" — it
              exports the whole filtered set, not the page on screen. */}
          <Button type="button" variant="ghost" size="sm" onClick={handleDownload} loading={downloading}>
            <Download size={14} />Download XLSX
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={clearFilters}>Clear</Button>
          <Button type="button" size="sm" onClick={applyFilters}>Search</Button>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1000px] text-xs xl:text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className={thCls}>Sr</th>
                {isAll && <th className={thCls}>Stage</th>}
                <th className={thCls}>Party Name</th>
                <th className={thCls}>Article</th>
                <th className={thCls}>Status</th>
                <th className={thCls}>Qty</th>
                <th className={thCls}>Balance</th>
                <th className={thCls}>Rate</th>
                <th className={thCls}>Process Rate</th>
                <th className={thCls}>After Rate</th>
                <th className={thCls}>Challan No</th>
                <th className={thCls}>Incoming No</th>
                <th className={thCls}>Checked By</th>
                <th className={thCls}>Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading && [...Array(5)].map((_, i) => (
                <tr key={`sk-${i}`}>
                  {[...Array(COLUMN_COUNT)].map((__, j) => (
                    <td key={j} className="px-3 py-3"><div className="h-4 bg-gray-100 rounded animate-pulse" /></td>
                  ))}
                </tr>
              ))}

              {!loading && rows.map((r, i) => (
                <Fragment key={r.lot_key}>
                  <tr className="hover:bg-gray-50/60">
                    <td className={`${tdCls} text-gray-400`}>{srBase + i + 1}</td>
                    {isAll && (
                      <td className={`${tdCls} font-medium text-[#003049] whitespace-nowrap`}>{r.stage}</td>
                    )}
                    <td className={`${tdCls} font-medium text-[#003049] whitespace-nowrap`}>{r.party_name}</td>
                    <td className={tdCls}>
                      <div className="text-[#003049] whitespace-nowrap">
                        {r.item_name}{r.variant ? ` — ${r.variant}` : ''}
                      </div>
                      <div className="text-[11px] text-gray-400">
                        PO {r.po_order_no}{r.unit_metric ? ` · ${r.unit_metric}` : ''}
                      </div>
                    </td>
                    <td className={tdCls}>
                      <Badge color={STATUS_COLORS[r.status] || 'gray'}>{r.status}</Badge>
                    </td>
                    <td className={`${tdCls} whitespace-nowrap`}>
                      {fmtNum(r.metre)}
                      {/* Sent more than came back: the difference was lost in processing. */}
                      {r.sent_qty != null && r.received_at
                        && Number(r.sent_qty) - Number(r.metre) > EPSILON && (
                        <div className="text-[11px] text-amber-600">
                          sent {fmtNum(r.sent_qty)} · loss {fmtNum(Number(r.sent_qty) - Number(r.metre))}
                        </div>
                      )}
                      {/* Nothing has arrived yet, so the quantity that matters is
                          what went out. */}
                      {!r.received_at && (
                        <div className="text-[11px] text-amber-600">sent {fmtNum(r.sent_qty)}</div>
                      )}
                    </td>
                    <td className={`${tdCls} font-semibold whitespace-nowrap ${Number(r.balance) > EPSILON ? 'text-amber-700' : 'text-gray-400'}`}>
                      {fmtNum(r.balance)}
                    </td>
                    <td className={`${tdCls} text-gray-600`}>{fmtNum(r.rate)}</td>
                    <td className={`${tdCls} text-gray-600`}>{fmtNum(r.process_rate)}</td>
                    <td className={`${tdCls} font-medium text-[#003049]`}>{fmtNum(r.after_rate)}</td>
                    {/* The challan this lot arrived under. Read-only: challans are
                        records of their own now, added and withdrawn as such. */}
                    <td className={`${tdCls} text-gray-600 whitespace-nowrap`}>{r.challan_no || '—'}</td>
                    <td className={`${tdCls} whitespace-nowrap`}>
                      {r.incoming_prefix || r.incoming_no
                        ? <span className="font-mono text-xs">{r.incoming_prefix || ''}{r.incoming_no || ''}</span>
                        : <span className="text-gray-300">—</span>}
                    </td>
                    <td className={`${tdCls} text-gray-600 whitespace-nowrap`}>{r.checked_by_name || '—'}</td>
                    <td className={tdCls}>
                      <div className="flex items-center gap-1">
                        {/* This lot is itself a challan still out at a processor. */}
                        {r.can_receive && (
                          <button
                            type="button"
                            onClick={() => setReceiving(r)}
                            title="Record what came back against this challan"
                            className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-[#c1121f] hover:bg-red-50"
                          >
                            <PackageCheck size={13} />Receive
                          </button>
                        )}
                        {r.stage === 'Packed' && r.received_at && !r.closed_at && (
                          <button
                            type="button"
                            onClick={() => setClosing(r)}
                            title="Mark this lot closed"
                            className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-[#003049] hover:bg-gray-100"
                          >
                            <PackageCheck size={13} />Close
                          </button>
                        )}
                        {r.stage === 'Packed' && r.closed_at && (
                          <button
                            type="button"
                            onClick={() => reopen(r)}
                            disabled={busyKey === r.lot_key}
                            title={`Closed by ${r.closed_by_name || 'unknown'} · ${formatDateTime(r.closed_at)}`}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-gray-500 hover:bg-gray-100 disabled:opacity-40"
                          >
                            <RotateCcw size={13} />Reopen
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => setJourneyFor(r)}
                          title="Trace this lot from the PO receipt to Packed"
                          className="p-1.5 rounded hover:bg-gray-100 text-gray-500"
                        >
                          <Route size={14} />
                        </button>
                        <HistoryButton
                          entityType={r.src === 'entry' ? 'stitching_entry' : 'outbound_po_line'}
                          entityId={r.src === 'entry' ? r.id : r.line_id}
                          title={`History — ${r.item_name}${r.variant ? ` ${r.variant}` : ''}`}
                        />
                        {r.src === 'receipt' && (
                          <Link
                            to={`/outbound/purchase-orders/${r.po_id}`}
                            title="Open the PO this lot arrived on"
                            className="p-1.5 rounded hover:bg-gray-100 text-gray-500"
                          >
                            <ExternalLink size={14} />
                          </Link>
                        )}
                        {r.src === 'entry' && (
                          <button
                            type="button"
                            onClick={() => setConfirmDelete(r)}
                            title="Remove this lot"
                            className="p-1.5 rounded hover:bg-red-50 text-red-500"
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>

                  {/* Challans raised against this lot, nested beneath it the way
                      receipts sit under a PO line. Each one is a dispatch: some
                      of this lot out at a processor, or already back. */}
                  {(r.challans || []).map(c => (
                    <tr key={c.lot_key} className="bg-gray-50/40">
                      <td className={tdCls} />
                      <td className={tdCls} colSpan={COLUMN_COUNT - 2}>
                        <div className="flex items-center gap-3 flex-wrap text-xs pl-4 border-l-2 border-gray-200">
                          <span className="text-gray-400">Challan</span>
                          <span className="font-mono text-[#003049]">{c.challan_no || '—'}</span>
                          <span className="text-gray-500">{c.party_name}</span>
                          <span className="text-gray-400">
                            sent <span className="font-medium text-gray-700">{fmtQty(c.sent_qty, r.unit_metric)}</span>
                          </span>
                          {c.received_at ? (
                            <span className="text-gray-400">
                              received <span className="font-medium text-gray-700">{fmtQty(c.metre, r.unit_metric)}</span>
                            </span>
                          ) : null}
                          <Badge color={STATUS_COLORS[c.status] || 'gray'}>{c.status}</Badge>
                          <span className="font-mono text-[11px] text-gray-400">
                            {c.incoming_prefix || ''}{c.incoming_no || ''}
                          </span>
                        </div>
                      </td>
                      <td className={tdCls}>
                        <div className="flex items-center gap-1">
                          {c.can_receive && (
                            <button
                              type="button"
                              onClick={() => setReceiving(c)}
                              title="Record what came back against this challan"
                              className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-[#c1121f] hover:bg-red-50"
                            >
                              <PackageCheck size={13} />Receive
                            </button>
                          )}
                          {/* A correction: the challan was entered against the
                              wrong lot, or never raised at all. Nothing travels
                              anywhere -- the quantity stops counting as sent. */}
                          {c.can_remove && (
                            <button
                              type="button"
                              onClick={() => setRemoving(c)}
                              title="Withdraw this challan — entered in error"
                              className="p-1.5 rounded hover:bg-amber-50 text-amber-600"
                            >
                              <Undo2 size={14} />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}

                  {/* A lot cannot reach the next stage except under a challan, so
                      this is the only way forward -- and it is on the lot rather
                      than behind an action menu for exactly that reason. */}
                  {r.can_forward && r.received_at && (
                    <tr className="bg-gray-50/40">
                      <td className={tdCls} />
                      <td className={tdCls} colSpan={COLUMN_COUNT - 1}>
                        <button
                          type="button"
                          onClick={() => setChallanFor(r)}
                          className="inline-flex items-center gap-1 ml-4 px-2 py-1 rounded text-xs text-[#c1121f] hover:bg-red-50"
                        >
                          <Plus size={13} />Add Challan
                          <span className="text-gray-400">
                            · {fmtQty(r.balance, r.unit_metric)} left to send to {r.next_stage}
                          </span>
                        </button>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}

              {!loading && !rows.length && (
                <tr>
                  <td colSpan={COLUMN_COUNT} className="px-3 py-8 text-center text-gray-400">
                    No lots here yet
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {!loading && rows.length === 0 && (
          <p className="text-center text-gray-400 py-8">
            No lots at the {stage} stage yet.
            {stage === 'Gray'
              ? ' A receipt appears here once it has an incoming number with a Gray prefix.'
              : ` Send a lot on from ${stage === 'Processed' ? 'Gray' : stage === 'Stitched' ? 'Processed' : 'Stitched'} to see it here.`}
          </p>
        )}

        <Pagination
          page={page}
          pageSize={pageSize}
          total={total}
          onPageChange={setPage}
          onPageSizeChange={(s) => { setPageSize(s); persistPageSize(pageSizeKey, s); setPage(1); }}
        />
      </div>

      {journeyFor && (
        <JourneyModal src={journeyFor.src} id={journeyFor.id} onClose={() => setJourneyFor(null)} />
      )}

      <ConfirmDialog
        isOpen={!!closing}
        onClose={() => setClosing(null)}
        onConfirm={handleClose}
        loading={busyKey === closing?.lot_key}
        confirmLabel="Close lot"
        title="Close this lot?"
        message={closing
          ? `Marks the ${fmtNum(closing.metre)} m at ${closing.party_name} as dispatched. It stops counting as open stock, and can be reopened if that was wrong.`
          : ''}
      />

      {challanFor && (
        <ChallanModal
          lot={challanFor}
          onClose={() => setChallanFor(null)}
          onSaved={() => { setChallanFor(null); load(); }}
        />
      )}

      {receiving && (
        <ReceiveModal
          challan={receiving}
          onClose={() => setReceiving(null)}
          onSaved={() => { setReceiving(null); load(); }}
        />
      )}

      {removing && (
        <RemoveChallanModal
          challan={removing}
          onClose={() => setRemoving(null)}
          onSaved={load}
        />
      )}

      <ConfirmDialog
        isOpen={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        onConfirm={handleDelete}
        loading={deleting}
        title="Remove this lot?"
        message={confirmDelete
          ? `This removes the ${confirmDelete.stage} lot at ${confirmDelete.party_name} and returns ${fmtNum(confirmDelete.sent_qty)} to the lot it came from.`
          : ''}
      />
    </>
  );
}
