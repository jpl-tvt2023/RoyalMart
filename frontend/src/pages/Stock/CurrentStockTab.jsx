import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { getStockSummary } from '../../api/stock.api';
import { formatDateTime } from '../../utils/formatters';
import { articleText, fmt, toastMessage } from './stockHelpers';

// Current stock: one row per article and floor. A pack sits on the floor it
// was last scanned on (its sticker's floor if it has never been counted).
// Pieces are pack size x packs, so a part-used pack counts in full until its
// sticker stops being scanned.

const COLS = 7;

export default function CurrentStockTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [floorFilter, setFloorFilter] = useState('');

  useEffect(() => {
    getStockSummary()
      .then(setData)
      .catch((err) => toast.error(toastMessage(err, 'Could not load stock')))
      .finally(() => setLoading(false));
  }, []);

  const rows = (data?.rows || []).filter((r) => !floorFilter || r.floor_id === Number(floorFilter));
  const floors = [...new Map((data?.rows || []).map((r) => [r.floor_id, r.floor_name])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1]));
  const t = data?.totals;

  return (
    <div className="space-y-4">
      {data && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Tile label="In stock" value={`${fmt(t.in_stock_packs)} packs`} sub={`${fmt(t.in_stock_pcs)} pcs`} />
          <Tile label="Went Out on the last count" value={`${fmt(t.out_last_packs)} packs`} sub={`${fmt(t.out_last_pcs)} pcs`} />
          <Tile label="Not yet counted" value={`${fmt(t.not_counted_packs)} packs`} sub="stickered, never scanned" />
          <Tile label="On the wrong floor" value={`${fmt(t.flagged_packs)} packs`} sub="in stock, not where the sticker says" warn={t.flagged_packs > 0} />
        </div>
      )}

      <section className="bg-white rounded-xl border border-gray-200">
        <div className="flex flex-wrap items-end justify-between gap-3 p-4 border-b border-gray-100">
          <p className="text-sm text-gray-600">
            {data?.latest_count
              ? <>As of count #{data.latest_count.id}, closed {formatDateTime(data.latest_count.closed_at)} by {data.latest_count.closed_by}.</>
              : 'No count has been closed yet — every stickered pack shows as Not yet counted.'}
            {data?.open_count && <span className="ml-1 text-amber-700">Count #{data.open_count.id} is in progress; it counts once it is closed.</span>}
          </p>
          <label className="block w-48">
            <span className="block text-xs font-medium text-gray-600 mb-1">Floor</span>
            <select value={floorFilter} onChange={(e) => setFloorFilter(e.target.value)} className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30">
              <option value="">All floors</option>
              {floors.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
          </label>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-gray-50 text-left text-xs font-semibold text-gray-600 uppercase tracking-wide">
              <tr>
                <th className="px-4 py-3">Article</th>
                <th className="px-4 py-3">Floor</th>
                <th className="px-4 py-3 text-right">In stock (packs)</th>
                <th className="px-4 py-3 text-right">In stock (pcs)</th>
                <th className="px-4 py-3 text-right">Out on last count</th>
                <th className="px-4 py-3 text-right">Not yet counted</th>
                <th className="px-4 py-3 text-right">Wrong floor</th>
              </tr>
            </thead>
            <tbody>
              {loading && Array.from({ length: 4 }).map((_, i) => (
                <tr key={`sk-${i}`} className="border-b border-gray-100">
                  {Array.from({ length: COLS }).map((__, j) => <td key={j} className="px-4 py-3"><div className="h-4 bg-gray-100 rounded animate-pulse" /></td>)}
                </tr>
              ))}
              {!loading && rows.map((r) => (
                <tr key={`${r.article_id}:${r.floor_id}`} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="px-4 py-3 text-[#003049] font-medium">{articleText(r)}</td>
                  <td className="px-4 py-3 whitespace-nowrap">{r.floor_name}</td>
                  <td className="px-4 py-3 text-right tabular-nums font-semibold">{fmt(r.in_stock_packs)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{fmt(r.in_stock_pcs)}{r.unit_metric ? ` ${r.unit_metric}` : ''}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{r.out_last_packs ? `${fmt(r.out_last_packs)} (${fmt(r.out_last_pcs)})` : '—'}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-gray-500">{r.not_counted_packs ? fmt(r.not_counted_packs) : '—'}</td>
                  <td className={`px-4 py-3 text-right tabular-nums ${r.flagged_packs ? 'text-amber-700 font-semibold' : 'text-gray-400'}`}>{r.flagged_packs ? fmt(r.flagged_packs) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && !rows.length && (
            <p className="text-center text-sm text-gray-500 py-10">No stickered stock{floorFilter ? ' on this floor' : ''} yet.</p>
          )}
        </div>
      </section>
    </div>
  );
}

function Tile({ label, value, sub, warn }) {
  return (
    <div className={`bg-white rounded-xl border p-4 ${warn ? 'border-amber-300' : 'border-gray-200'}`}>
      <p className="text-xs font-medium text-gray-500">{label}</p>
      <p className={`text-xl font-bold tabular-nums ${warn ? 'text-amber-700' : 'text-[#003049]'}`}>{value}</p>
      <p className="text-xs text-gray-400">{sub}</p>
    </div>
  );
}
