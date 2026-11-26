import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Search } from 'lucide-react';
import Button from '../../components/ui/Button';
import Modal from '../../components/ui/Modal';
import Badge from '../../components/ui/Badge';
import Pagination, { loadPersistedPageSize, persistPageSize } from '../../components/ui/Pagination';
import { listMissedScans, listMissedPacks, getStickerHistory } from '../../api/stock.api';
import { formatDateTime } from '../../utils/formatters';
import { keyError } from '../../utils/barcodeStation';
import { articleText, fmt, labelText, packText, toastMessage } from './stockHelpers';

// ADMIN/OWNER ONLY (the server refuses anyone else). A missed scan is a pack a
// count did not find that turned up again on a later count -- so it was there
// all along, and the scanner missed it. Miss rate = missed / (found + missed):
// of the packs that were really there, the share he did not scan.

const PAGE_SIZE_KEY = 'stock.missed';
const COLS = 6;

const STATUS_BADGE = {
  in_stock: { color: 'green', label: 'In stock' },
  out: { color: 'red', label: 'Out' },
  not_counted: { color: 'gray', label: 'Not yet counted' },
};

export default function MissedScansTab() {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [totalMissed, setTotalMissed] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(() => loadPersistedPageSize(PAGE_SIZE_KEY, 25));
  const [selected, setSelected] = useState(null);
  const [lookup, setLookup] = useState('');
  const [history, setHistory] = useState(null);

  const fetchRows = useCallback((o = {}) => listMissedScans({ page: o.page ?? page, page_size: o.pageSize ?? pageSize })
    .then((res) => { setRows(res.rows); setTotal(res.total); setTotalMissed(res.total_missed); })
    .catch((err) => toast.error(toastMessage(err, 'Could not load missed scans')))
    .finally(() => setLoading(false)), [page, pageSize]);
  const load = (o) => { setLoading(true); return fetchRows(o); };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { fetchRows(); }, []);

  const openHistory = async (key) => {
    const err = keyError(key);
    if (err) { toast.error(err); return; }
    try {
      setHistory(await getStickerHistory(key));
    } catch (ex) {
      toast.error(toastMessage(ex, 'Sticker lookup failed'));
    }
  };

  return (
    <div className="space-y-4">
      <section className="bg-white rounded-xl border border-gray-200">
        <div className="flex flex-wrap items-end justify-between gap-3 p-4 border-b border-gray-100">
          <p className="text-sm text-gray-600">
            <span className="font-semibold text-[#003049]">{fmt(totalMissed)}</span> missed scan{totalMissed !== 1 ? 's' : ''} across every count.
          </p>
          <form onSubmit={(e) => { e.preventDefault(); openHistory(lookup.trim()); }} className="flex items-end gap-2">
            <label className="block">
              <span className="block text-xs font-medium text-gray-600 mb-1">Sticker history</span>
              <div className="relative">
                <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  value={lookup}
                  onChange={(e) => setLookup(e.target.value.replace(/\D/g, '').slice(0, 8))}
                  inputMode="numeric"
                  placeholder="8-digit key"
                  className="w-44 pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30"
                />
              </div>
            </label>
            <Button type="submit" variant="secondary">Look up</Button>
          </form>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-gray-50 text-left text-xs font-semibold text-gray-600 uppercase tracking-wide">
              <tr>
                <th className="px-4 py-3">Count</th>
                <th className="px-4 py-3">Closed</th>
                <th className="px-4 py-3">Scanned by</th>
                <th className="px-4 py-3 text-right">Found</th>
                <th className="px-4 py-3 text-right">Missed</th>
                <th className="px-4 py-3 text-right">Miss rate</th>
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
                  onClick={() => c.missed && setSelected(selected?.id === c.id ? null : c)}
                  className={`border-b border-gray-100 ${c.missed ? 'cursor-pointer hover:bg-gray-50' : ''} ${selected?.id === c.id ? 'bg-[#fdf0d5]/60' : ''}`}
                >
                  <td className="px-4 py-3 font-medium text-[#003049]">#{c.id}</td>
                  <td className="px-4 py-3 whitespace-nowrap text-gray-600">{formatDateTime(c.closed_at)}</td>
                  <td className="px-4 py-3">{c.operators.join(', ') || '—'}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{fmt(c.found)}</td>
                  <td className={`px-4 py-3 text-right tabular-nums ${c.missed ? 'font-semibold text-[#c1121f]' : 'text-gray-400'}`}>{fmt(c.missed)}</td>
                  <td className={`px-4 py-3 text-right tabular-nums ${c.miss_rate >= 2 ? 'text-[#c1121f] font-medium' : ''}`}>{c.miss_rate}%</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && !rows.length && <p className="text-center text-sm text-gray-500 py-10">No count has been closed yet.</p>}
        </div>
        <Pagination
          page={page}
          pageSize={pageSize}
          total={total}
          onPageChange={(p) => { setPage(p); load({ page: p }); }}
          onPageSizeChange={(s) => { setPageSize(s); persistPageSize(PAGE_SIZE_KEY, s); setPage(1); load({ page: 1, pageSize: s }); }}
        />
      </section>

      {selected && <MissedPacks key={selected.id} count={selected} onOpenKey={openHistory} />}

      {history && <HistoryModal history={history} onClose={() => setHistory(null)} />}
    </div>
  );
}

function MissedPacks({ count, onOpenKey }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listMissedPacks(count.id, { page_size: 'all' })
      .then((res) => setRows(res.rows))
      .catch((err) => toast.error(toastMessage(err, 'Could not load the missed packs')))
      .finally(() => setLoading(false));
  }, [count.id]);

  return (
    <section className="bg-white rounded-xl border border-gray-200">
      <h3 className="p-4 border-b border-gray-100 text-sm font-semibold text-[#003049]">Missed on count #{count.id}</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs font-semibold text-gray-600 uppercase tracking-wide">
            <tr>
              <th className="px-4 py-3">Key</th>
              <th className="px-4 py-3">Label</th>
              <th className="px-4 py-3">Article</th>
              <th className="px-4 py-3 text-right">Pack</th>
              <th className="px-4 py-3">Sticker floor</th>
              <th className="px-4 py-3">Turned up on</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.label_key} className="border-b border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-2.5">
                  <button type="button" onClick={() => onOpenKey(String(p.label_key))} className="font-mono text-[#c1121f] hover:underline">{p.label_key}</button>
                </td>
                <td className="px-4 py-2.5 whitespace-nowrap text-gray-600">{labelText(p)}</td>
                <td className="px-4 py-2.5 text-[#003049]">{articleText(p)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums whitespace-nowrap">{packText(p)}</td>
                <td className="px-4 py-2.5 whitespace-nowrap">{p.sticker_floor_name}</td>
                <td className="px-4 py-2.5 whitespace-nowrap">count #{p.found_again_count_id}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {loading && <p className="text-center text-sm text-gray-400 py-8">Loading…</p>}
      </div>
    </section>
  );
}

function HistoryModal({ history: h, onClose }) {
  const badge = STATUS_BADGE[h.status] || STATUS_BADGE.not_counted;
  const missed = new Set(h.missed_on.map((m) => m.count_id));
  return (
    <Modal isOpen onClose={onClose} title={`Sticker ${h.label_key}`} size="md">
      <div className="space-y-4 text-sm">
        <div className="space-y-1">
          <p className="font-medium text-[#003049]">{h.vendor_name} · {articleText(h)}</p>
          <p className="text-gray-600">{labelText(h)} · pack of {packText(h)} · sticker floor {h.sticker_floor_name}</p>
          <p className="text-gray-600">Generated {formatDateTime(h.generated_at)} by {h.generated_by}</p>
          <p className="flex items-center gap-2">
            <Badge color={badge.color}>{badge.label}</Badge>
            {h.out_since && <span className="text-gray-600">since count #{h.out_since.count_id} ({formatDateTime(h.out_since.closed_at)})</span>}
          </p>
        </div>
        <div>
          <p className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-1">Counts it was seen on</p>
          {h.sightings.length === 0 && <p className="text-gray-500">Never scanned on a count.</p>}
          <ul className="divide-y divide-gray-100">
            {h.sightings.map((s) => (
              <li key={s.count_id} className="flex flex-wrap justify-between gap-2 py-1.5">
                <span>Count #{s.count_id}{s.closed_at ? '' : ' (open)'} · {s.floor_name}{s.floor_mismatch && <span className="text-amber-700"> (wrong floor)</span>}</span>
                <span className="text-gray-500">{formatDateTime(s.scanned_at)} · {s.scanned_by}</span>
              </li>
            ))}
          </ul>
        </div>
        {missed.size > 0 && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-red-800">
            Missed on count{missed.size > 1 ? 's' : ''} {[...missed].map((id) => `#${id}`).join(', ')} — it was there, but not scanned.
          </p>
        )}
      </div>
    </Modal>
  );
}
