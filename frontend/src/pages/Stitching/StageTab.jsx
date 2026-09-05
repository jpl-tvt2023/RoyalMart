import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Link } from 'react-router-dom';
import { Send, Trash2, ExternalLink } from 'lucide-react';
import Badge from '../../components/ui/Badge';
import Button from '../../components/ui/Button';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import Pagination, { loadPersistedPageSize, persistPageSize } from '../../components/ui/Pagination';
import { HistoryButton } from '../../components/shared/HistoryDrawer';
import { useSessionState } from '../../hooks/useSessionState';
import { listStitchingLots, deleteStitchingLot } from '../../api/stitching.api';
import { STATUSES, STATUS_COLORS, fmtNum } from '../../utils/stitching';
import ForwardModal from './ForwardModal';

const inputCls = 'w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f]';
// Density scales with the viewport, matching OutboundPODetail: tight enough for
// a 1366px laptop, roomier on a large monitor.
const thCls = 'px-2 py-2 xl:px-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap';
const tdCls = 'px-2 py-1.5 xl:px-3 xl:py-2';

const EMPTY_FILTERS = {
  party_name: '', incoming_no: '', bill_no: '', challan_no: '', po_order_no: '', status: '',
};

export default function StageTab({ stage }) {
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
  const [forwarding, setForwarding] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = { stage, page, page_size: pageSize };
      for (const [k, v] of Object.entries(filters)) {
        if (String(v || '').trim()) params[k] = String(v).trim();
      }
      const data = await listStitchingLots(params);
      setRows(data.rows || []);
      setTotal(data.total || 0);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not load lots');
      setRows([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [stage, page, pageSize, filters]);

  useEffect(() => { load(); }, [load]);

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

  // Sr is a plain running number within the tab, continuing across pages.
  const srBase = (page - 1) * pageSize;

  return (
    <>
      <div className="bg-white rounded-xl border border-gray-200 p-4 mb-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
          <input placeholder="Party Name" value={draft.party_name} onChange={e => setDraftField('party_name', e.target.value)} onKeyDown={onFilterKeyDown} className={inputCls} />
          <input placeholder="Incoming No" value={draft.incoming_no} onChange={e => setDraftField('incoming_no', e.target.value)} onKeyDown={onFilterKeyDown} className={inputCls} />
          <input placeholder="Bill No" value={draft.bill_no} onChange={e => setDraftField('bill_no', e.target.value)} onKeyDown={onFilterKeyDown} className={inputCls} />
          <input placeholder="Challan No" value={draft.challan_no} onChange={e => setDraftField('challan_no', e.target.value)} onKeyDown={onFilterKeyDown} className={inputCls} />
          <input placeholder="PO No" value={draft.po_order_no} onChange={e => setDraftField('po_order_no', e.target.value)} onKeyDown={onFilterKeyDown} className={inputCls} />
          <select value={draft.status} onChange={e => setDraftField('status', e.target.value)} className={inputCls}>
            <option value="">All statuses</option>
            {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div className="flex justify-end gap-2 mt-3">
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
                <th className={thCls}>Party Name</th>
                <th className={thCls}>Bill No</th>
                <th className={thCls}>Article</th>
                <th className={thCls}>Status</th>
                <th className={thCls}>Metre</th>
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
                  {[...Array(14)].map((__, j) => (
                    <td key={j} className="px-3 py-3"><div className="h-4 bg-gray-100 rounded animate-pulse" /></td>
                  ))}
                </tr>
              ))}

              {!loading && rows.map((r, i) => (
                <tr key={r.lot_key} className="hover:bg-gray-50/60">
                  <td className={`${tdCls} text-gray-400`}>{srBase + i + 1}</td>
                  <td className={`${tdCls} font-medium text-[#003049] whitespace-nowrap`}>{r.party_name}</td>
                  <td className={`${tdCls} text-gray-600`}>{r.bill_no || '—'}</td>
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
                    {/* Sent > received means the difference was lost in processing. */}
                    {r.sent_qty != null && Number(r.sent_qty) - Number(r.metre) > 0.005 && (
                      <div className="text-[11px] text-amber-600">
                        sent {fmtNum(r.sent_qty)} · loss {fmtNum(Number(r.sent_qty) - Number(r.metre))}
                      </div>
                    )}
                  </td>
                  <td className={`${tdCls} font-semibold whitespace-nowrap ${Number(r.balance) > 0.005 ? 'text-amber-700' : 'text-gray-400'}`}>
                    {fmtNum(r.balance)}
                  </td>
                  <td className={`${tdCls} text-gray-600`}>{fmtNum(r.rate)}</td>
                  <td className={`${tdCls} text-gray-600`}>{fmtNum(r.process_rate)}</td>
                  <td className={`${tdCls} font-medium text-[#003049]`}>{fmtNum(r.after_rate)}</td>
                  <td className={`${tdCls} text-gray-600`}>{r.challan_no || '—'}</td>
                  <td className={`${tdCls} whitespace-nowrap`}>
                    {r.incoming_prefix || r.incoming_no
                      ? <span className="font-mono text-xs">{r.incoming_prefix || ''}{r.incoming_no || ''}</span>
                      : <span className="text-gray-300">—</span>}
                  </td>
                  <td className={`${tdCls} text-gray-600 whitespace-nowrap`}>{r.checked_by_name || '—'}</td>
                  <td className={tdCls}>
                    <div className="flex items-center gap-1">
                      {r.can_forward && (
                        <button
                          type="button"
                          onClick={() => setForwarding(r)}
                          title={`Send to ${r.next_stage}`}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-[#c1121f] hover:bg-red-50"
                        >
                          <Send size={13} />Add Rec
                        </button>
                      )}
                      {/* Only stage entries are deletable here — an origin lot is
                          a PO receipt and is managed on the PO itself. */}
                      {r.src === 'entry' && (
                        <button
                          type="button"
                          onClick={() => setConfirmDelete(r)}
                          title="Remove this lot"
                          className="p-1.5 rounded hover:bg-red-50 text-red-500"
                        >
                          <Trash2 size={13} />
                        </button>
                      )}
                      {/* An origin lot IS a PO receipt — its history lives on the
                          PO line, not on this row, so link to the PO rather than
                          open a drawer keyed to the wrong entity. */}
                      {r.src === 'entry' ? (
                        <HistoryButton entityType="stitching_entry" entityId={r.id} title={`${r.stage} lot history`} />
                      ) : (
                        <Link
                          to={`/outbound/purchase-orders/${r.po_id}`}
                          title={`Open PO ${r.po_order_no}`}
                          className="p-1.5 rounded hover:bg-gray-100 text-gray-500 inline-flex"
                        >
                          <ExternalLink size={14} />
                        </Link>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
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

      {forwarding && (
        <ForwardModal
          lot={forwarding}
          onClose={() => setForwarding(null)}
          onSaved={() => { setForwarding(null); load(); }}
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
