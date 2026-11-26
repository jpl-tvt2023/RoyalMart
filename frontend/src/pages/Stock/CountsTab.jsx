import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { RotateCcw } from 'lucide-react';
import Button from '../../components/ui/Button';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import Pagination, { loadPersistedPageSize, persistPageSize } from '../../components/ui/Pagination';
import { listStockCounts, listStockCountPacks, reopenStockCount } from '../../api/stock.api';
import { formatDateTime } from '../../utils/formatters';
import { articleText, fmt, labelText, packText, toastMessage } from './stockHelpers';

// Every closed count with what it found. Out is the FINAL figure: a pack that
// turned up again on a later count is not Out here (it was a missed scan, which
// only Admin/Owner see, on its own tab). Packs are named by batch and label,
// never by key.

const PAGE_SIZE_KEY = 'stock.counts';
const PACK_PAGE_SIZE_KEY = 'stock.countPacks';
const LISTS = [
  { key: 'out', label: 'Went Out' },
  { key: 'new', label: 'New' },
  { key: 'flagged', label: 'Wrong floor' },
  { key: 'found', label: 'All found' },
];
const COLS = 7;

export default function CountsTab({ isAdmin }) {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [openCount, setOpenCount] = useState(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(() => loadPersistedPageSize(PAGE_SIZE_KEY, 25));
  const [selected, setSelected] = useState(null);
  const [confirmReopen, setConfirmReopen] = useState(null);
  const [busy, setBusy] = useState(false);

  const fetchRows = useCallback((o = {}) => listStockCounts({ page: o.page ?? page, page_size: o.pageSize ?? pageSize })
    .then((res) => { setRows(res.rows); setTotal(res.total); setOpenCount(res.open_count); })
    .catch((err) => toast.error(toastMessage(err, 'Could not load counts')))
    .finally(() => setLoading(false)), [page, pageSize]);

  const load = (o) => { setLoading(true); return fetchRows(o); };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { fetchRows(); }, []);

  const latestId = page === 1 && rows.length ? rows[0].id : null;

  const doReopen = async () => {
    setBusy(true);
    try {
      await reopenStockCount(confirmReopen.id);
      toast.success(`Count #${confirmReopen.id} reopened — the station can carry on scanning`);
      setConfirmReopen(null);
      setSelected(null);
      load();
    } catch (err) {
      toast.error(toastMessage(err, 'Reopen failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {openCount && (
        <p className="rounded-lg bg-amber-50 border border-amber-200 px-4 py-2 text-sm text-amber-800">
          Count #{openCount.id} is in progress — started {formatDateTime(openCount.started_at)} by {openCount.started_by}, {fmt(openCount.scanned)} scanned so far.
        </p>
      )}

      <section className="bg-white rounded-xl border border-gray-200">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-gray-50 text-left text-xs font-semibold text-gray-600 uppercase tracking-wide">
              <tr>
                <th className="px-4 py-3">Count</th>
                <th className="px-4 py-3">Closed</th>
                <th className="px-4 py-3 text-right">Found</th>
                <th className="px-4 py-3 text-right">New</th>
                <th className="px-4 py-3 text-right">Went Out</th>
                <th className="px-4 py-3 text-right">Wrong floor</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && Array.from({ length: 4 }).map((_, i) => (
                <tr key={`sk-${i}`} className="border-b border-gray-100">
                  {Array.from({ length: COLS }).map((__, j) => <td key={j} className="px-4 py-3"><div className="h-4 bg-gray-100 rounded animate-pulse" /></td>)}
                </tr>
              ))}
              {!loading && rows.map((c) => (
                <tr
                  key={c.id}
                  onClick={() => setSelected(selected?.id === c.id ? null : c)}
                  className={`border-b border-gray-100 cursor-pointer hover:bg-gray-50 ${selected?.id === c.id ? 'bg-[#fdf0d5]/60' : ''}`}
                >
                  <td className="px-4 py-3 font-medium text-[#003049]">#{c.id}{c.seq === 1 && <span className="ml-2 text-xs font-normal text-gray-500">(first count)</span>}</td>
                  <td className="px-4 py-3 whitespace-nowrap text-gray-600">{formatDateTime(c.closed_at)} · {c.closed_by}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{fmt(c.found)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{fmt(c.new_packs)}</td>
                  <td className={`px-4 py-3 text-right tabular-nums ${c.out_packs ? 'font-semibold text-[#c1121f]' : ''}`}>{fmt(c.out_packs)}</td>
                  <td className={`px-4 py-3 text-right tabular-nums ${c.flagged ? 'text-amber-700 font-semibold' : 'text-gray-400'}`}>{fmt(c.flagged)}</td>
                  <td className="px-4 py-3 text-right">
                    {isAdmin && c.id === latestId && !openCount && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setConfirmReopen(c); }}
                        className="inline-flex items-center gap-1 text-xs font-medium text-[#003049] hover:underline"
                        title="Reopen this count (Admin/Owner) — for a count closed too early"
                      >
                        <RotateCcw size={13} /> Reopen
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && !rows.length && (
            <p className="text-center text-sm text-gray-500 py-10">No count has been closed yet.</p>
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

      {selected && <CountPacks key={selected.id} count={selected} />}

      <ConfirmDialog
        isOpen={!!confirmReopen}
        onClose={() => setConfirmReopen(null)}
        onConfirm={doReopen}
        loading={busy}
        title="Reopen this count?"
        confirmLabel="Reopen"
        message={confirmReopen
          ? `Count #${confirmReopen.id} goes back to in progress, with its ${confirmReopen.found} scans kept. Its packs are not marked Out until it is closed again.`
          : ''}
      />
    </div>
  );
}

function CountPacks({ count }) {
  const [list, setList] = useState('out');
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(() => loadPersistedPageSize(PACK_PAGE_SIZE_KEY, 25));

  // State is only set in the promise callbacks, so the mount effect can call
  // this directly; `load` adds the synchronous loading flag for later fetches.
  const fetchRows = useCallback((o = {}) => listStockCountPacks(count.id, { list: o.list ?? list, page: o.page ?? page, page_size: o.pageSize ?? pageSize })
    .then((res) => { setRows(res.rows); setTotal(res.total); })
    .catch((err) => toast.error(toastMessage(err, 'Could not load packs')))
    .finally(() => setLoading(false)), [count.id, list, page, pageSize]);
  const load = (o) => { setLoading(true); return fetchRows(o); };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { fetchRows(); }, []);

  const pick = (key) => { setList(key); setPage(1); load({ list: key, page: 1 }); };
  const seenLabel = list === 'out' ? 'Last seen on' : 'Scanned on';

  return (
    <section className="bg-white rounded-xl border border-gray-200">
      <div className="flex flex-wrap items-center gap-2 p-4 border-b border-gray-100">
        <h3 className="text-sm font-semibold text-[#003049] mr-2">Count #{count.id}</h3>
        {LISTS.map((l) => (
          <Button key={l.key} size="sm" variant={list === l.key ? 'secondary' : 'ghost'} onClick={() => pick(l.key)}>{l.label}</Button>
        ))}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs font-semibold text-gray-600 uppercase tracking-wide">
            <tr>
              <th className="px-4 py-3">Label</th>
              <th className="px-4 py-3">Vendor</th>
              <th className="px-4 py-3">Article</th>
              <th className="px-4 py-3 text-right">Pack</th>
              <th className="px-4 py-3">Sticker floor</th>
              <th className="px-4 py-3">{seenLabel}</th>
            </tr>
          </thead>
          <tbody>
            {!loading && rows.map((p) => (
              <tr key={`${p.batch_id}:${p.label_no}`} className="border-b border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-2.5 whitespace-nowrap text-gray-600">{labelText(p)}</td>
                <td className="px-4 py-2.5">{p.vendor_name}</td>
                <td className="px-4 py-2.5 text-[#003049]">{articleText(p)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums whitespace-nowrap">{packText(p)}</td>
                <td className="px-4 py-2.5 whitespace-nowrap">{p.sticker_floor_name}</td>
                <td className={`px-4 py-2.5 whitespace-nowrap ${p.seen_floor_id && p.seen_floor_id !== p.sticker_floor_id ? 'text-amber-700 font-medium' : ''}`}>{p.seen_floor_name || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {loading && <p className="text-center text-sm text-gray-400 py-8">Loading…</p>}
        {!loading && !rows.length && <p className="text-center text-sm text-gray-500 py-8">Nothing in this list for count #{count.id}.</p>}
      </div>
      <Pagination
        page={page}
        pageSize={pageSize}
        total={total}
        onPageChange={(p) => { setPage(p); load({ page: p }); }}
        onPageSizeChange={(s) => { setPageSize(s); persistPageSize(PACK_PAGE_SIZE_KEY, s); setPage(1); load({ page: 1, pageSize: s }); }}
      />
    </section>
  );
}
