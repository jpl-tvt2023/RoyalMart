import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
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
  statusesFor, STATUS_COLORS, fmtNum, EPSILON, ALL_TAB,
  EXIT_STAGE, STOCK_STAGE, countsDozens, metresPerDozen, NONE_SELECTED,
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

// A hover card for the two numbers on this page that need their working shown:
// the rate total and the metres per dozen. Positioned FIXED off the trigger's
// own rectangle rather than absolutely inside the cell, because the table
// scrolls sideways -- and an overflow container clips anything absolute inside
// it, which would cut the card off at the table's edge.
function HoverTip({ content, children }) {
  const [pos, setPos] = useState(null);
  const show = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    // Kept inside the viewport: 320 is the card's width.
    setPos({ top: r.bottom + 6, left: Math.max(8, Math.min(r.left, window.innerWidth - 328)) });
  };
  return (
    <span
      onMouseEnter={show}
      onMouseLeave={() => setPos(null)}
      onFocus={show}
      onBlur={() => setPos(null)}
      tabIndex={0}
      className="cursor-help underline decoration-dotted decoration-gray-300 underline-offset-2 outline-none"
    >
      {children}
      {pos && (
        <span
          role="tooltip"
          style={{ top: pos.top, left: pos.left }}
          className="fixed z-50 block w-80 rounded-lg border border-gray-200 bg-white p-3 text-xs font-normal text-gray-600 shadow-lg whitespace-normal no-underline"
        >
          {content}
        </span>
      )}
    </span>
  );
}

const unitLabel = (unit) => (unit === 'dozen' ? 'dz' : 'm');

// ONE rate per lot: what a dozen of it has cost so far, every stage included.
// The server builds it (rateTotal in stitching.service.js) and hands back the
// working, which the card lays out line by line: each rate as it was entered,
// how a per-metre one was turned into a per-dozen one, and the sum.
function RateCell({ r }) {
  if (r.rate_total == null) return <span className="text-gray-300">—</span>;
  const perDozen = r.rate_total_unit === 'dozen';
  const content = (
    <>
      <span className="block font-semibold text-[#003049] mb-1">
        How the {perDozen ? 'per-dozen' : 'per-metre'} rate adds up
      </span>
      {(r.rate_breakdown || []).map(l => (
        <span key={l.label} className="flex justify-between gap-3 py-0.5">
          <span>{l.label}</span>
          <span className="font-mono text-right">
            {l.unit === 'metre' && perDozen
              ? `${fmtNum(l.rate)}/m × ${fmtNum(r.metres_per_dozen)} m/dz = ${fmtNum(l.contributes)}`
              : `${fmtNum(l.contributes ?? l.rate)}/${unitLabel(l.unit)}`}
          </span>
        </span>
      ))}
      <span className="flex justify-between gap-3 border-t border-gray-100 mt-1 pt-1 font-semibold text-[#003049]">
        <span>Total</span>
        <span className="font-mono">{fmtNum(r.rate_total)}/{perDozen ? 'dz' : 'm'}</span>
      </span>
      <span className="block mt-2 text-[11px] text-gray-400">
        {perDozen
          ? `Rates quoted per metre are turned into per-dozen by multiplying by the metres it takes to make a dozen (${fmtNum(r.metres_per_dozen)} m).`
          : 'This lot is still in metres, so the rate is per metre. It becomes per dozen once the goods are counted in dozens.'}
      </span>
    </>
  );
  return (
    <HoverTip content={content}>
      {fmtNum(r.rate_total)}<span className="text-gray-400">/{perDozen ? 'dz' : 'm'}</span>
    </HoverTip>
  );
}

// Metres per dozen, with where it came from in plain words. A lot sent on from
// Stitching records dozens only, so its figure is CARRIED from the challan (or
// PO receipt) where fabric was first counted in dozens -- and the card says so,
// rather than leaving a number nobody can trace.
function YieldCell({ r }) {
  if (r.metres_per_dozen == null) return <span className="text-gray-300">—</span>;
  const s = r.m_per_dozen_source;
  let content;
  if (!s) {
    content = `${fmtNum(r.metres_per_dozen)} metres of fabric made each dozen.`;
  } else {
    const how = `${fmtNum(s.metres)} m of fabric became ${fmtNum(s.dozens)} dozen, so each dozen took ${fmtNum(r.metres_per_dozen)} m.`;
    const where = s.kind === 'receipt'
      ? `the PO receipt (bought in at ${s.stage})`
      : `challan ${s.challan_no || '—'}${s.challan_type ? ` (${s.challan_type})` : ''} out of ${s.stage}`;
    content = s.carried
      ? `Carried over from ${where}: ${how} After that the goods are counted in dozens only, so the metres per dozen stays the same.`
      : `From ${where}: ${how}`;
  }
  return <HoverTip content={content}>{fmtNum(r.metres_per_dozen)}</HoverTip>;
}

const qtyWithUnit = (value, unit) => (value == null ? '—' : `${fmtNum(value)} ${unit === 'dz' ? 'dz' : 'm'}`);

const Dot = () => <span className="text-gray-300">·</span>;

// Where a lot came from, for the line under its PO party. A lot that arrived on
// a challan lists each job worker it passed through as "<stage it left> - <short
// name>", origin first. A lot booked straight in on a PO receipt has no challan
// party, and says so -- every row gets the same second line on every tab.
function cameFrom(r) {
  const chain = r.party_chain || [];
  if (!chain.length) return r.src === 'receipt' ? { latest: 'Direct from PO', more: 0, full: 'Direct from PO' } : { latest: '', more: 0, full: '' };
  return { latest: chain[chain.length - 1], more: chain.length - 1, full: chain.join(' · ') };
}

// Always exactly two lines, so every row keeps the same height: the PO party,
// then where the lot came from. A longer chain shows only its latest hop plus a
// muted count, with the whole chain on hover.
function PartyCell({ r }) {
  const from = cameFrom(r);
  return (
    <>
      <div className="font-medium text-[#003049] whitespace-nowrap">{r.vendor_name}</div>
      {from.latest && (
        <div className="max-w-[14rem] truncate whitespace-nowrap text-[11px] text-gray-400" title={from.full}>
          {from.latest}
          {from.more > 0 && <span className="text-gray-300"> +{from.more}</span>}
        </div>
      )}
    </>
  );
}

// The lines of one challan share its number, party and destination, and arrive
// from the server in the order they were written -- so consecutive rows with
// the same three are one challan. Write-offs never group: each is its own event.
function groupOutgoing(outgoing) {
  const groups = [];
  for (const c of outgoing || []) {
    const key = c.is_write_off ? `wo:${c.id}` : `${c.challan_no}|${c.party_name}|${c.stage}`;
    const last = groups[groups.length - 1];
    if (last && last.key === key && !c.is_write_off) last.lines.push(c);
    else groups.push({ key, lines: [c] });
  }
  return groups;
}

// What one challan line took out of its lot, in the lot's unit. Out of
// Processing that is metres, with the dozens they came back as and the yield
// beside them; out of a dozen stage it is dozens and nothing else.
function lineQty(c, parentUnit) {
  if (parentUnit === 'dz') {
    return <>sent <span className="font-medium text-gray-700">{fmtNum(c.sent_dozens)} dz</span></>;
  }
  const mpd = metresPerDozen(c.sent_qty, c.received_dozens);
  return (
    <>
      sent <span className="font-medium text-gray-700">{fmtNum(c.sent_qty)} m</span>
      {c.received_dozens != null && <> → <span className="font-medium text-gray-700">{fmtNum(c.received_dozens)} dz</span></>}
      {mpd != null && <span className="text-gray-400"> · {fmtNum(mpd)} m/dz</span>}
    </>
  );
}

// Everything that has LEFT a lot, nested beneath it the way receipts sit under
// a PO line: challans sent on, and material written off. A challan with more
// than one line gets a total row ABOVE its lines, so the whole challan reads
// before its parts.
function OutgoingRows({ lot, columnCount, onEdit, onRemove }) {
  const unit = lot.balance_unit;
  const rowActions = (c) => (
    <td className={tdCls}>
      <div className="flex items-center gap-1">
        {/* Correct a challan line in place. Gated the same way withdrawing is:
            once material has moved on from it, or it has been closed, changing
            what it says would leave the chain describing something that did
            not happen. A write-off is withdrawn and re-raised instead. */}
        {c.can_remove && !c.is_write_off && (
          <button type="button" onClick={() => onEdit(c)} title="Edit this challan line"
            className="p-1.5 rounded hover:bg-blue-50 text-blue-600">
            <Pencil size={14} />
          </button>
        )}
        {c.can_remove && (
          <button type="button" onClick={() => onRemove(c)}
            title={c.is_write_off ? 'Withdraw this write-off — entered in error' : 'Withdraw this challan line — entered in error'}
            className="p-1.5 rounded hover:bg-amber-50 text-amber-600">
            <Undo2 size={14} />
          </button>
        )}
      </div>
    </td>
  );

  // One fixed reading order, a quiet dot between each part:
  //   Challan 02 → Panchal · Mahakali creation · Fresh · sent 3570.5 dz · [In Stock]
  // The status is the only badge -- it says what became of the goods at the
  // next stage, which is the one thing this tab cannot otherwise show. The
  // destination lot's incoming number is deliberately NOT repeated here: it is
  // the parent's own suffix under another prefix, and it lives on that tab.
  const challanHead = (c) => (
    <>
      <span className="text-gray-400">Challan</span>
      <span className="font-mono text-[#003049]">{c.challan_no || '—'}</span>
      {/* Where it went. Obvious on a one-destination stage, load-bearing
          anywhere the lot branched. */}
      <span className="text-gray-400">→ <span className="text-gray-600">{c.stage}</span></span>
      <Dot />
      <span className="text-gray-600">{c.party_name}</span>
      {c.outbound_bill_no && (
        <>
          <Dot />
          <span className="text-gray-400">bill <span className="font-mono text-gray-600">{c.outbound_bill_no}</span></span>
        </>
      )}
    </>
  );

  const lineBody = (c) => (
    <>
      {c.challan_type && <><Dot /><span className="text-gray-600">{c.challan_type}</span></>}
      <Dot />
      <span className="text-gray-400">{lineQty(c, unit)}</span>
      <Dot />
      <Badge color={STATUS_COLORS[c.status] || 'gray'}>{c.status}</Badge>
    </>
  );

  return groupOutgoing(lot.outgoing).map(g => {
    const [first] = g.lines;
    if (first.is_write_off) {
      return (
        <tr key={g.key} className="bg-gray-50/40">
          <td className={tdCls} />
          <td className={tdCls} colSpan={columnCount - 2}>
            <div className="flex items-center gap-2 flex-wrap text-xs pl-4 border-l-2 border-gray-200">
              <span className="text-amber-600 font-medium">Written off</span>
              <span className="font-medium text-gray-700">
                {qtyWithUnit(first.sent_dozens ?? first.sent_qty, unit)}
              </span>
              <span className="text-gray-500">{first.write_off_reason}</span>
            </div>
          </td>
          {rowActions(first)}
        </tr>
      );
    }
    if (g.lines.length === 1) {
      return (
        <tr key={g.key} className="bg-gray-50/40">
          <td className={tdCls} />
          <td className={tdCls} colSpan={columnCount - 2}>
            <div className="flex items-center gap-2 flex-wrap text-xs pl-4 border-l-2 border-gray-200">
              {challanHead(first)}
              {lineBody(first)}
            </div>
          </td>
          {rowActions(first)}
        </tr>
      );
    }
    // Several lines: the total first, then each line indented beneath it.
    const sentTotal = unit === 'dz'
      ? g.lines.reduce((s, c) => s + Number(c.sent_dozens || 0), 0)
      : g.lines.reduce((s, c) => s + Number(c.sent_qty || 0), 0);
    const dozenTotal = g.lines.reduce((s, c) => s + Number(c.received_dozens || 0), 0);
    const mpd = unit === 'dz' ? null : metresPerDozen(sentTotal, dozenTotal);
    return (
      <Fragment key={g.key}>
        <tr className="bg-gray-50/40">
          <td className={tdCls} />
          <td className={tdCls} colSpan={columnCount - 1}>
            <div className="flex items-center gap-2 flex-wrap text-xs pl-4 border-l-2 border-gray-300">
              {challanHead(first)}
              <Dot />
              <span className="font-semibold text-[#003049]">
                Total · {g.lines.length} lines · sent {qtyWithUnit(sentTotal, unit)}
                {unit !== 'dz' && ` → ${fmtNum(dozenTotal)} dz`}
                {mpd != null && ` · ${fmtNum(mpd)} m/dz`}
              </span>
            </div>
          </td>
        </tr>
        {g.lines.map(c => (
          <tr key={c.lot_key} className="bg-gray-50/40">
            <td className={tdCls} />
            <td className={tdCls} colSpan={columnCount - 2}>
              <div className="flex items-center gap-2 flex-wrap text-xs pl-10 border-l-2 border-gray-200">
                <span className="text-gray-400">Line {c.challan_line_no}</span>
                {lineBody(c)}
              </div>
            </td>
            {rowActions(c)}
          </tr>
        ))}
      </Fragment>
    );
  });
}

// Stage is included even on a single-stage tab: a saved file outlives the tab it
// came from.
const EXPORT_COLUMNS = [
  { key: 'stage', header: 'Stage' },
  { key: 'vendor_name', header: 'PO Party Name' },
  { key: 'party_name', header: 'Challan Party' },
  { key: 'party_chain', header: 'Parties' },
  { key: 'item_name', header: 'Article' },
  { key: 'variant', header: 'Variant' },
  { key: 'po_order_no', header: 'PO No' },
  { key: 'status', header: 'Status' },
  { key: 'po_qty_metres', header: 'PO Qty (m)' },
  { key: 'sent_qty', header: 'Sent (m)' },
  { key: 'received_qty', header: 'Qty (m)' },
  { key: 'sent_dozens', header: 'Sent (dz)' },
  { key: 'received_dozens', header: 'Dozens' },
  { key: 'metres_per_dozen', header: 'M/Dozen' },
  { key: 'balance', header: 'Balance' },
  { key: 'balance_unit', header: 'Balance Unit' },
  { key: 'po_rate', header: 'PO Rate' },
  // The total and its working, flattened: a spreadsheet cannot hover.
  { key: 'rate_total', header: 'Rate' },
  { key: 'rate_total_unit', header: 'Rate Per' },
  { key: 'rate_breakdown', header: 'Rate Breakdown' },
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
  const [storedFilters, setFilters] = useSessionState(
    `stitching.filters.v3.${stage}`, () => defaultFilters(stage),
  );
  // Only statuses this tab can show. A session saved before the filter was
  // narrowed may hold one the tab never produces -- dropped here, and if that
  // leaves nothing of a non-empty pick, the tab's own default rather than a
  // filter that silently matches no rows.
  const filters = useMemo(() => {
    const allowed = statusesFor(stage);
    const picked = storedFilters.status || [];
    const kept = picked.filter(st => allowed.includes(st));
    return {
      ...storedFilters,
      status: picked.length && !kept.length ? defaultStatusFor(stage) : kept,
    };
  }, [storedFilters, stage]);
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
  // What a tab counts in. Processing is the one metre stage. From Stitching on
  // the goods are dozens, and at the two terminal stages -- the warehouse and
  // the sale -- only the dozens matter: nothing forwards out of them, so there
  // is no balance to work down and no yield left to act on.
  const isStockTab = stage === STOCK_STAGE;
  const isTerminal = isStockTab || isExitTab;
  const showsDozens = countsDozens(stage);
  const showsYield = isAll || (showsDozens && !isTerminal);
  const showsBalance = !isTerminal;
  // The two destinations that record who checked the goods over.
  const showsChecker = isStockTab || isExitTab;

  // THE COLUMNS, as one list, so a header can never drift from its cell and the
  // skeleton, empty row and nested colspans all count the same thing. Sr and
  // Actions bracket these and are rendered on their own.
  const columns = [
    isAll && {
      key: 'stage', header: 'Stage',
      cell: r => <span className="font-medium text-[#003049] whitespace-nowrap">{r.stage}</span>,
    },
    {
      // The PO party is the one name every lot in a chain shares, so it leads
      // on every tab. The job workers the goods passed through sit beneath it,
      // as "<Stage> - <party short name>".
      key: 'po_party', header: 'PO Party Name',
      cell: r => <PartyCell r={r} />,
    },
    {
      key: 'article', header: 'Article',
      cell: r => (
        <div className="text-[#003049] whitespace-nowrap">
          {r.item_name}{r.variant ? ` — ${r.variant}` : ''}
        </div>
      ),
    },
    {
      // Between the article and its status, where a lot is identified.
      key: 'po', header: 'PO No',
      cell: r => (
        <Link to={`/outbound/purchase-orders/${r.po_id}`} className="font-mono text-[#003049] hover:underline">
          {r.po_order_no}
        </Link>
      ),
    },
    {
      key: 'status', header: 'Status',
      cell: r => <Badge color={STATUS_COLORS[r.status] || 'gray'}>{r.status}</Badge>,
    },
    {
      // The metre figure the whole chain started from, on every tab.
      key: 'po_qty', header: 'PO Qty (m)',
      cell: r => <span className="text-gray-600 whitespace-nowrap">{fmtNum(r.po_qty_metres)}</span>,
    },
    (stage === 'Processing') && {
      key: 'qty', header: 'Qty (m)',
      cell: r => (
        <span className="whitespace-nowrap">
          {fmtNum(r.received_qty)}
          {r.sent_qty != null && <span className="block text-[11px] text-gray-400">sent {fmtNum(r.sent_qty)}</span>}
        </span>
      ),
    },
    showsDozens && {
      key: 'dozens', header: 'Dozens',
      cell: r => <span className="text-gray-600 whitespace-nowrap">{r.received_dozens == null ? '' : fmtNum(r.received_dozens)}</span>,
    },
    // The All view mixes units, so its quantity carries one.
    isAll && {
      key: 'qty', header: 'Qty',
      cell: r => <span className="whitespace-nowrap">{qtyWithUnit(r.qty_basis, r.balance_unit)}</span>,
    },
    showsYield && {
      key: 'yield', header: 'M/Dozen',
      cell: r => <span className="text-gray-600"><YieldCell r={r} /></span>,
    },
    showsBalance && {
      key: 'balance',
      header: stage === 'Processing' ? 'Balance (m)' : (isAll ? 'Balance' : 'Balance (dz)'),
      cell: r => (
        <span className={`font-semibold whitespace-nowrap ${Number(r.balance) > EPSILON ? 'text-amber-700' : 'text-gray-400'}`}>
          {isAll ? qtyWithUnit(r.balance, r.balance_unit) : fmtNum(r.balance)}
        </span>
      ),
    },
    isExitTab && {
      key: 'bill', header: 'Outbound Bill No',
      cell: r => <span className="font-mono text-[#003049]">{r.outbound_bill_no || '—'}</span>,
    },
    {
      // One figure -- the whole cost so far -- with the working on hover.
      key: 'rate', header: 'Rate',
      cell: r => <span className="whitespace-nowrap"><RateCell r={r} /></span>,
    },
    {
      key: 'incoming', header: 'Incoming No',
      cell: r => (r.incoming_prefix || r.incoming_no
        ? <span className="font-mono text-xs whitespace-nowrap">{r.incoming_prefix || ''}{r.incoming_no || ''}</span>
        : <span className="text-gray-300">—</span>),
    },
    // The warehouse's own number, beside the chain's, because at Panchal both
    // are real and they are not the same number.
    isStockTab && {
      key: 'pcl', header: 'PCL Inc No',
      cell: r => (r.panchal_incoming_no
        ? <span className="font-mono text-xs whitespace-nowrap">{r.panchal_incoming_no}</span>
        : <span className="text-gray-300">—</span>),
    },
    showsChecker && {
      key: 'checker', header: 'Checked By',
      cell: r => <span className="text-gray-600 whitespace-nowrap">{r.checked_by_name || <span className="text-gray-300">—</span>}</span>,
    },
  ].filter(Boolean);

  const COLUMN_COUNT = columns.length + 2;

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
        vendor_name: r.vendor_name || '',
        party_name: r.party_name || '',
        party_chain: cameFrom(r).full,
        item_name: r.item_name || '',
        variant: r.variant || '',
        po_order_no: r.po_order_no || '',
        status: r.status,
        // Numbers stay numbers, with the unit in its own column. A spreadsheet
        // exists to sum this, which "5 dz" in the cell would prevent.
        po_qty_metres: r.po_qty_metres ?? '',
        sent_qty: r.sent_qty ?? '',
        received_qty: r.received_qty ?? '',
        sent_dozens: r.sent_dozens ?? '',
        received_dozens: r.received_dozens ?? '',
        metres_per_dozen: r.metres_per_dozen ?? '',
        balance: r.balance,
        balance_unit: r.balance_unit || '',
        po_rate: r.po_rate,
        rate_total: r.rate_total ?? '',
        rate_total_unit: r.rate_total_unit || '',
        rate_breakdown: (r.rate_breakdown || [])
          .map(l => `${l.label} ${fmtNum(l.rate)}/${l.unit === 'dozen' ? 'dz' : 'm'}`).join('; '),
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
          <input placeholder="PO / Challan Party" value={draft.party_name} onChange={e => setDraftField('party_name', e.target.value)} onKeyDown={onFilterKeyDown} className={inputCls} />
          <input placeholder="Incoming No" value={draft.incoming_no} onChange={e => setDraftField('incoming_no', e.target.value)} onKeyDown={onFilterKeyDown} className={inputCls} />
          <input placeholder="Challan No" value={draft.challan_no} onChange={e => setDraftField('challan_no', e.target.value)} onKeyDown={onFilterKeyDown} className={inputCls} />
          <input placeholder="PO No" value={draft.po_order_no} onChange={e => setDraftField('po_order_no', e.target.value)} onKeyDown={onFilterKeyDown} className={inputCls} />
          <MultiSelect
            options={statusesFor(stage)}
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
                {columns.map(c => <th key={c.key} className={thCls}>{c.header}</th>)}
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
                    {columns.map(c => <td key={c.key} className={tdCls}>{c.cell(r)}</td>)}
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

                  {/* Everything that has LEFT this lot. Not on the All tab,
                      where every challan is already a row of its own and this
                      would print it twice. */}
                  {!isAll && (
                    <OutgoingRows
                      lot={r}
                      columnCount={COLUMN_COUNT}
                      onEdit={c => setEditingChallan({ lot: r, challan: c })}
                      onRemove={setRemoving}
                    />
                  )}

                  {/* A lot cannot reach the next stage except under a challan, so
                      this is the only way forward -- and it is on the lot rather
                      than behind an action menu for exactly that reason. */}
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
                            · {qtyWithUnit(r.balance, r.balance_unit)} left to send to{' '}
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
            {!isAll && (stage === 'Processing'
              ? ' A fabric receipt booked at Processing on an outbound PO appears here.'
              : ' Add a challan on a lot at an earlier stage, or book a receipt straight into this stage.')}
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
          ? `Marks the ${qtyWithUnit(closing.received_dozens, 'dz')} at ${closing.party_name} as dispatched. It stops counting as open stock, and can be reopened if that was wrong.`
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
          ? `This removes the ${confirmDelete.stage} lot at ${confirmDelete.party_name} and returns ${confirmDelete.sent_dozens != null ? `${fmtNum(confirmDelete.sent_dozens)} dz` : `${fmtNum(confirmDelete.sent_qty)} m`} to the lot it came from.`
          : ''}
      />
    </>
  );
}
