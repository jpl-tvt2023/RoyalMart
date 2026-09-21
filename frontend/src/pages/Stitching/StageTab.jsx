import { Fragment, useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Link } from 'react-router-dom';
import * as XLSX from 'xlsx';
import { Plus, Pencil, Trash2, ExternalLink, Route, PackageCheck, RotateCcw, Undo2, Download, Ban } from 'lucide-react';
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
import {
  STATUSES, STATUS_COLORS, fmtNum, fmtQty, EPSILON, ALL_TAB,
  STAGES, EXIT_STAGE, STOCK_STAGE, rateLadderStages, countsDozens, NONE_SELECTED,
} from '../../utils/stitching';
import MultiSelect from '../../components/ui/MultiSelect';
import { formatDateTime } from '../../utils/formatters';
import JourneyModal from './JourneyModal';
import ChallanModal from './ChallanModal';
import WriteOffModal from './WriteOffModal';
import RemoveChallanModal from './RemoveChallanModal';

const inputCls = 'w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f]';
// Density scales with the viewport, matching OutboundPODetail: tight enough for
// a 1366px laptop, roomier on a large monitor.
const thCls = 'px-2 py-2 xl:px-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap';
const tdCls = 'px-2 py-1.5 xl:px-3 xl:py-2';

// Which statuses a tab opens on. Every tab shows its own LIVE work rather than
// everything it has ever held: the list is for what still needs doing, and
// finished rows are one tick away.
//
// Per tab, because "live" is not the same word at every stage. Pending and
// Partial are lots with material still to send on, which is the whole of the
// job-work chain -- but nothing is ever Pending at the two terminal stages.
// Panchal holds stock (In Stock) until it is closed, and Third Party has only
// ever been Sold. Defaulting those two to Pending + Partial would open them
// empty, which reads as no data rather than as a filter.
const defaultStatusFor = (stage) => {
  if (stage === STOCK_STAGE) return ['In Stock'];
  if (stage === EXIT_STAGE) return ['Sold'];
  return ['Pending', 'Partial'];
};

// A factory, not a shared constant: the object is handed to useSessionState per
// tab and to clearFilters on every reset, and one shared literal would let a
// mutation leak across tabs.
const defaultFilters = (stage) => ({
  party_name: '', incoming_no: '', challan_no: '', po_order_no: '',
  status: defaultStatusFor(stage),
});

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
  { key: 'sent_qty', header: 'Sent' },
  { key: 'received_qty', header: 'Qty in metres' },
  { key: 'received_dozens', header: 'Dozens' },
  { key: 'metres_per_dozen', header: 'M/Dozen' },
  { key: 'balance', header: 'Balance' },
  { key: 'unit_metric', header: 'Unit' },
  { key: 'po_rate', header: 'PO Rate' },
  // One column per stage the material passed through, flattened out of
  // rate_ladder below. A spreadsheet cannot nest, and the whole point of the
  // ladder is comparing the stages side by side.
  ...STAGES.filter(st => st !== EXIT_STAGE).map(st => ({ key: `rate_${st}`, header: `${st} Rate` })),
  // The challan this row was sent under. It is off the table on purpose — a lot
  // has many, and they read better nested — but a spreadsheet has no nesting, so
  // here it belongs on the row it describes. Blank on an origin lot, which
  // nobody sent.
  { key: 'challan_no', header: 'Challan No' },
  { key: 'challan_type', header: 'Challan Type' },
  { key: 'outbound_bill_no', header: 'Outbound Bill No' },
  { key: 'incoming_no', header: 'Incoming No' },
  { key: 'panchal_incoming_no', header: 'PCL Inc No' },
  { key: 'checked_by_name', header: 'Checked By' },
  { key: 'updated_by_name', header: 'Updated By' },
  { key: 'updated_at', header: 'Updated At' },
];

export default function StageTab({ stage, onOpenCounts }) {
  const pageSizeKey = 'stitching.pageSize';
  // v3: status went from a single string to an array of them. useSessionState
  // does no shape validation, so a session holding the old value would arrive
  // in a component that now calls .length on it.
  const [filters, setFilters] = useSessionState(
    `stitching.filters.v3.${stage}`, () => defaultFilters(stage),
  );
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
  const [writingOff, setWritingOff] = useState(null);
  const [removing, setRemoving] = useState(null);
  // { lot, challan } -- the modal needs the parent to check the balance against,
  // and the row to correct.
  const [editingChallan, setEditingChallan] = useState(null);
  const [busyKey, setBusyKey] = useState(null);
  const [downloading, setDownloading] = useState(false);

  // "All" is a view across every stage, not a stage the server knows about.
  const isAll = stage === ALL_TAB;
  // The exit tab is a record of goods that have left: no balance to work down,
  // no stage rate still to be agreed, and nothing to forward.
  const isExitTab = stage === EXIT_STAGE;
  // Dozens and yield only mean something where there are pieces to count, which
  // is every stage from Stitched on. Left off the All view, where most rows
  // would be blank -- 'All' is not a stage, so countsDozens says no for free.
  //
  // Where dozens show, METRES DO NOT. From Stitched on the business counts
  // pieces, and leading with a metre figure invites reading the wrong number
  // off the row. Balance is the exception and stays in metres -- see its header.
  const showsDozens = countsDozens(stage);
  // Panchal files what it takes in under its own number, separate from the
  // incoming no carried down the chain.
  const isStockTab = stage === STOCK_STAGE;
  // The two destinations that record who checked the goods over.
  const showsChecker = isStockTab || isExitTab;

  // Which stage-rate columns this tab shows. On a stage tab, only the stages a
  // lot could actually have travelled to get here — a Stitched lot cannot have a
  // Packed rate. The All view spans everything.
  const ladderStages = isAll
    ? STAGES.filter(st => st !== EXIT_STAGE)
    : rateLadderStages(stage);

  // Stage only earns a column when rows can differ — on a stage tab every row
  // would repeat the tab's own name. Counted rather than hardcoded now that the
  // rate columns vary by tab: Sr, Party, Article, Status, Qty in metres, Balance,
  // Incoming No, Actions is the fixed spine.
  const COLUMN_COUNT = 8 + (isAll ? 1 : 0) + 1 + ladderStages.length
    + (isExitTab ? 1 : 0) + (showsDozens ? 2 - 1 : 0)
    + (isStockTab ? 1 : 0) + (showsChecker ? 1 : 0);

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
      // Status is the one multi-value filter, and the only one where an EMPTY
      // value has to be sent rather than dropped: the loop below treats a blank
      // as "unconstrained", which is the opposite of what no statuses ticked
      // means. String(v) on an array would also stringify to a comma list by
      // accident rather than on purpose.
      if (Array.isArray(v)) {
        params[k] = v.length ? v.join(',') : NONE_SELECTED;
      } else if (String(v || '').trim()) {
        params[k] = String(v).trim();
      }
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
        sent_qty: r.sent_qty,
        received_qty: r.received_qty,
        received_dozens: r.received_dozens ?? '',
        metres_per_dozen: r.metres_per_dozen ?? '',
        balance: r.balance,
        unit_metric: r.unit_metric || '',
        po_rate: r.po_rate,
        // Flatten the ladder into one column per stage. A stage the lot never
        // travelled stays blank rather than becoming 0 — it was not charged
        // nothing, it was never there.
        ...Object.fromEntries(STAGES.filter(st => st !== EXIT_STAGE)
          .map(st => [`rate_${st}`, r.rate_ladder?.[st] ?? ''])),
        challan_no: r.challan_no || '',
        challan_type: r.challan_type || '',
        outbound_bill_no: r.outbound_bill_no || '',
        incoming_no: `${r.incoming_prefix || ''}${r.incoming_no || ''}`,
        panchal_incoming_no: r.panchal_incoming_no || '',
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
  // Back to the tab's own defaults, not to empty: Clear means "start again",
  // and the starting point here shows live work rather than everything.
  const clearFilters = () => {
    const d = defaultFilters(stage);
    setDraft(d); setFilters(d); setPage(1);
  };
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
          <MultiSelect
            options={STATUSES}
            selected={draft.status}
            onChange={v => setDraftField('status', v)}
            allLabel="All statuses"
          />
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
                {/* Metres up to Stitched, dozens from there on -- never both.
                    The receipt side is qty_in_metres and the entry side inherits
                    it, so the header names the unit rather than leaving it to
                    the Article sub-line. */}
                {!showsDozens && <th className={thCls}>Qty in metres</th>}
                {showsDozens && <th className={thCls}>Dozens</th>}
                {showsDozens && <th className={thCls}>M/Dozen</th>}
                {/* No Short. A challan records what was SENT and nothing else,
                    so short is 0 on every one of them and was always NULL on an
                    origin lot nobody sent — Balance is what shows material still
                    to come. The column stays in the API, where the journey
                    summary still totals it. */}
                {/* Named in metres on the dozen tabs, because the header that
                    used to carry the unit is gone there. Balance stays metres
                    everywhere: it is what caps Sent Qty on the challan form,
                    and the chain's unit has not changed -- only what the row
                    leads with has. */}
                <th className={thCls}>{showsDozens ? 'Balance (m)' : 'Balance'}</th>
                {isExitTab && <th className={thCls}>Outbound Bill No</th>}
                <th className={thCls}>PO Rate</th>
                {/* One column per stage travelled, rather than a single running
                    total. The old After Rate rolled every stage into one number,
                    which is exactly what hid what each one charged. */}
                {ladderStages.map(st => (
                  <th key={st} className={thCls}>{st} Rate</th>
                ))}
                {/* No Challan No. A lot has many challans and they sit nested
                    beneath it, so a single column here could only ever show one
                    of them — and on an origin lot it showed a stale number the
                    PO screen no longer manages. */}
                <th className={thCls}>Incoming No</th>
                {/* The warehouse's own number, beside the chain's, because at
                    Panchal both are real and they are not the same number. */}
                {isStockTab && <th className={thCls}>PCL Inc No</th>}
                {/* Only where it was actually asked for. Everywhere else the
                    server takes it from the session, so the column could only
                    repeat whoever typed the row -- which the History drawer
                    already records. */}
                {showsChecker && <th className={thCls}>Checked By</th>}
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
                    {!showsDozens && (
                      <td className={`${tdCls} whitespace-nowrap`}>
                        {fmtNum(r.received_qty)}
                        {r.sent_qty != null && (
                          <div className="text-[11px] text-gray-400">sent {fmtNum(r.sent_qty)}</div>
                        )}
                      </td>
                    )}
                    {showsDozens && (
                      <td className={`${tdCls} text-gray-600 whitespace-nowrap`}>
                        {r.received_dozens == null ? '' : fmtNum(r.received_dozens)}
                        {/* Rehomed from the metres cell, which is not rendered
                            on this tab. What was dispatched is the point of a
                            sale row and has to stay somewhere. */}
                        {r.sent_qty != null && (
                          <div className="text-[11px] text-gray-400">sent {fmtNum(r.sent_qty)}m</div>
                        )}
                      </td>
                    )}
                    {showsDozens && (
                      <td className={`${tdCls} text-gray-600`}>
                        {/* The yield, derived server-side from the two numbers
                            beside it so a stored copy can never disagree. */}
                        {r.metres_per_dozen == null ? '' : fmtNum(r.metres_per_dozen)}
                      </td>
                    )}
                    <td className={`${tdCls} font-semibold whitespace-nowrap ${Number(r.balance) > EPSILON ? 'text-amber-700' : 'text-gray-400'}`}>
                      {fmtNum(r.balance)}
                    </td>
                    {isExitTab && (
                      <td className={`${tdCls} font-mono text-[#003049]`}>
                        {r.outbound_bill_no || '—'}
                      </td>
                    )}
                    <td className={`${tdCls} text-gray-600`}>{fmtNum(r.po_rate)}</td>
                    {ladderStages.map(st => (
                      <td
                        key={st}
                        className={`${tdCls} ${st === r.stage ? 'font-medium text-[#003049]' : 'text-gray-600'}`}
                      >
                        {/* Blank, not 0, for a stage this lot never travelled:
                            it was not charged nothing, it was never there. */}
                        {r.rate_ladder?.[st] == null ? '' : fmtNum(r.rate_ladder[st])}
                      </td>
                    ))}
                    <td className={`${tdCls} whitespace-nowrap`}>
                      {r.incoming_prefix || r.incoming_no
                        ? <span className="font-mono text-xs">{r.incoming_prefix || ''}{r.incoming_no || ''}</span>
                        : <span className="text-gray-300">—</span>}
                    </td>
                    {isStockTab && (
                      <td className={`${tdCls} whitespace-nowrap`}>
                        {r.panchal_incoming_no
                          ? <span className="font-mono text-xs">{r.panchal_incoming_no}</span>
                          : <span className="text-gray-300">—</span>}
                      </td>
                    )}
                    {showsChecker && (
                      <td className={`${tdCls} text-gray-600 whitespace-nowrap`}>
                        {r.checked_by_name || <span className="text-gray-300">—</span>}
                      </td>
                    )}
                    <td className={tdCls}>
                      <div className="flex items-center gap-1">
                        {/* Material that will never move on: ruined at rest, or
                            gone. Not a stage move, so it names no destination. */}
                        {Number(r.balance) > EPSILON && !r.is_exit && (
                          <button
                            type="button"
                            onClick={() => setWritingOff(r)}
                            title="Write material off this lot"
                            className="p-1.5 rounded hover:bg-amber-50 text-amber-600"
                          >
                            <Ban size={14} />
                          </button>
                        )}
                        {r.stage === STOCK_STAGE && !r.closed_at && (
                          <button
                            type="button"
                            onClick={() => setClosing(r)}
                            title="Mark this lot closed"
                            className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-[#003049] hover:bg-gray-100"
                          >
                            <PackageCheck size={13} />Close
                          </button>
                        )}
                        {r.stage === STOCK_STAGE && r.closed_at && (
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
                          title="Trace this lot from the PO receipt to where it ended up"
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

                  {/* Everything that has LEFT this lot, nested beneath it the way
                      receipts sit under a PO line: challans sent on, and material
                      written off. Not on the All tab, where every challan is
                      already a row of its own and this would print it twice. */}
                  {!isAll && (r.outgoing || []).map(c => (
                    <tr key={c.lot_key} className="bg-gray-50/40">
                      <td className={tdCls} />
                      <td className={tdCls} colSpan={COLUMN_COUNT - 2}>
                        <div className="flex items-center gap-3 flex-wrap text-xs pl-4 border-l-2 border-gray-200">
                          {c.is_write_off ? (
                            <>
                              <span className="text-amber-600 font-medium">Written off</span>
                              <span className="font-medium text-gray-700">
                                {fmtQty(c.sent_qty, r.unit_metric)}
                              </span>
                              <span className="text-gray-500">{c.write_off_reason}</span>
                            </>
                          ) : (
                            <>
                              <span className="text-gray-400">Challan</span>
                              <span className="font-mono text-[#003049]">{c.challan_no || '—'}</span>
                              {c.challan_type && (
                                <Badge color="gray">{c.challan_type}</Badge>
                              )}
                              {/* Where it went. Obvious on a one-destination
                                  stage, load-bearing anywhere the lot branched. */}
                              <span className="text-gray-400">
                                → <span className="text-gray-600">{c.stage}</span>
                              </span>
                              <span className="text-gray-500">{c.party_name}</span>
                              {c.outbound_bill_no && (
                                <span className="text-gray-400">
                                  bill <span className="font-mono text-gray-600">{c.outbound_bill_no}</span>
                                </span>
                              )}
                              <span className="text-gray-400">
                                sent <span className="font-medium text-gray-700">{fmtQty(c.sent_qty, r.unit_metric)}</span>
                              </span>
                              <Badge color={STATUS_COLORS[c.status] || 'gray'}>{c.status}</Badge>
                              <span className="font-mono text-[11px] text-gray-400">
                                {c.incoming_prefix || ''}{c.incoming_no || ''}
                              </span>
                            </>
                          )}
                        </div>
                      </td>
                      <td className={tdCls}>
                        <div className="flex items-center gap-1">
                          {/* Correct a challan in place -- a wrong number, party
                              or quantity. Gated the same way withdrawing is:
                              once material has moved on from this challan, or it
                              has been closed, changing what it says would leave
                              the chain describing something that did not happen.
                              A write-off has no fields worth editing, so it is
                              withdrawn and re-raised instead. */}
                          {c.can_remove && !c.is_write_off && (
                            <button
                              type="button"
                              onClick={() => setEditingChallan({ lot: r, challan: c })}
                              title="Edit this challan"
                              className="p-1.5 rounded hover:bg-blue-50 text-blue-600"
                            >
                              <Pencil size={14} />
                            </button>
                          )}
                          {/* A correction: the challan was entered against the
                              wrong lot, or the write-off was wrong. Nothing
                              travels anywhere -- the quantity stops counting as
                              gone. */}
                          {c.can_remove && (
                            <button
                              type="button"
                              onClick={() => setRemoving(c)}
                              title={c.is_write_off
                                ? 'Withdraw this write-off — entered in error'
                                : 'Withdraw this challan — entered in error'}
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
                      than behind an action menu for exactly that reason. Every
                      stage works this way, not just Gray. */}
                  {r.can_forward && (
                    <tr className="bg-gray-50/40">
                      <td className={tdCls} />
                      <td className={tdCls} colSpan={COLUMN_COUNT - 1}>
                        <button
                          type="button"
                          onClick={() => setChallanFor(r)}
                          className="inline-flex items-center gap-1 ml-4 px-2 py-1 rounded text-xs text-[#c1121f] hover:bg-red-50"
                        >
                          <Plus size={13} />Add Challan
                          {/* The destinations are named here rather than just
                              the next one, because there is now a choice and it
                              is made inside the modal. Seeing it up front is
                              what stops the modal being a surprise. */}
                          <span className="text-gray-400">
                            · {fmtQty(r.balance, r.unit_metric)} left to send to{' '}
                            {(r.destinations || []).join(', ') || r.next_stage}
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
            {isAll
              ? 'No lots yet. A receipt appears here once it has an incoming number with a stage prefix.'
              : `No lots at the ${stage} stage yet.`}
            {!isAll && (stage === 'Gray'
              ? ' A receipt appears here once it has an incoming number with a Gray prefix.'
              : ' Add a challan on a lot at the previous stage to send some of it here.')}
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
          ? `Marks the ${fmtQty(closing.received_qty, closing.unit_metric)} at ${closing.party_name} as dispatched. It stops counting as open stock, and can be reopened if that was wrong.`
          : ''}
      />

      {challanFor && (
        <ChallanModal
          lot={challanFor}
          onClose={() => setChallanFor(null)}
          onSaved={() => { setChallanFor(null); load(); }}
        />
      )}

      {editingChallan && (
        <ChallanModal
          lot={editingChallan.lot}
          challan={editingChallan.challan}
          onClose={() => setEditingChallan(null)}
          onSaved={() => { setEditingChallan(null); load(); }}
        />
      )}

      {writingOff && (
        <WriteOffModal
          lot={writingOff}
          onClose={() => setWritingOff(null)}
          onSaved={() => { setWritingOff(null); load(); }}
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
