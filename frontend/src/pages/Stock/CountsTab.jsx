import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import Button from '../../components/ui/Button';
import Pagination, { loadPersistedPageSize, persistPageSize } from '../../components/ui/Pagination';
import { listStockCounts, listStockCountPacks } from '../../api/stock.api';
import { formatDate } from '../../utils/formatters';
import { articleText, fmt, labelText, packText, toastMessage } from './stockHelpers';

// One row per day with scans (migration 103: the count is the IST day, finished
// at midnight). Today's row is In progress: found / new / wrong floor so far,
// and no Out until it finishes. Out is the FINAL figure: a pack that turned up
// again on a later day is not Out here (it was a missed scan, which only
// Admin/Owner see, on its own tab). Packs are named by batch and label, never
// by key.

const PAGE_SIZE_KEY = 'stock.counts';
const PACK_PAGE_SIZE_KEY = 'stock.countPacks';
const LISTS = [
  { key: 'out', label: 'Went Out', finishedOnly: true },
  { key: 'new', label: 'New' },
  { key: 'flagged', label: 'Wrong floor' },
  { key: 'found', label: 'All found' },
];
const COLS = 6;

export default function CountsTab() {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(() => loadPersistedPageSize(PAGE_SIZE_KEY, 25));
  const [selected, setSelected] = useState(null);

  const fetchRows = useCallback((o = {}) => listStockCounts({ page: o.page ?? page, page_size: o.pageSize ?? pageSize })
    .then((res) => { setRows(res.rows); setTotal(res.total); })
    .catch((err) => toast.error(toastMessage(err, 'Could not load counts')))
    .finally(() => setLoading(false)), [page, pageSize]);

  const load = (o) => { setLoading(true); return fetchRows(o); };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { fetchRows(); }, []);

  return (
    <div className="space-y-4">
      <section className="bg-white rounded-xl border border-gray-200">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-gray-50 text-left text-xs font-semibold text-gray-600 uppercase tracking-wide">
              <tr>
                <th className="px-4 py-3">Day</th>
                <th className="px-4 py-3">First scan by</th>
                <th className="px-4 py-3 text-right">Found</th>
                <th className="px-4 py-3 text-right">New</th>
                <th className="px-4 py-3 text-right">Went Out</th>
                <th className="px-4 py-3 text-right">Wrong floor</th>
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
                  <td className="px-4 py-3 whitespace-nowrap font-medium text-[#003049]">
                    {formatDate(c.count_date)}
                    {!c.finished && (
                      <span className="ml-2 rounded bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-800">In progress</span>
                    )}
                    {c.finished && c.seq === 1 && <span className="ml-2 text-xs font-normal text-gray-500">(first count)</span>}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-gray-600">{c.started_by}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{fmt(c.found)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{fmt(c.new_packs)}</td>
                  <td
                    className={`px-4 py-3 text-right tabular-nums ${c.out_packs ? 'font-semibold text-[#c1121f]' : ''} ${c.finished ? '' : 'text-gray-400'}`}
                    title={c.finished ? undefined : 'Out shows after midnight, once the day is finished'}
                  >
                    {fmt(c.out_packs)}
                  </td>
                  <td className={`px-4 py-3 text-right tabular-nums ${c.flagged ? 'text-amber-700 font-semibold' : 'text-gray-400'}`}>{fmt(c.flagged)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && !rows.length && (
            <p className="text-center text-sm text-gray-500 py-10">Nothing has been scanned yet. The first day with scans becomes the starting point.</p>
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
    </div>
  );
}

function CountPacks({ count }) {
  const lists = LISTS.filter((l) => count.finished || !l.finishedOnly);
  const [list, setList] = useState(lists[0].key);
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
  const dayText = formatDate(count.count_date);

  return (
    <section className="bg-white rounded-xl border border-gray-200">
      <div className="flex flex-wrap items-center gap-2 p-4 border-b border-gray-100">
        <h3 className="text-sm font-semibold text-[#003049] mr-2">
          {dayText}{!count.finished && <span className="ml-1 font-normal text-gray-500">(in progress — Out shows after midnight)</span>}
        </h3>
        {lists.map((l) => (
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
        {!loading && !rows.length && <p className="text-center text-sm text-gray-500 py-8">Nothing in this list for {dayText}.</p>}
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
