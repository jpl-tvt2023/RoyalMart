import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import Button from '../../components/ui/Button';
import { getCrossCheck } from '../../api/stock.api';
import { fmt, istDate, toastMessage } from './stockHelpers';

// ADMIN/OWNER ONLY. Per labelled article: the pieces that went Out on counts
// closed in the window, against what POs dispatched in the window should have
// used (each SKU's packaging / barcode usage per unit, migration 061 -- the
// same link Procurement orders packaging by).
//
// Read it by the week, not the day: packing happens before dispatch, and a
// pack only goes Out once its sticker stops being scanned. PO lines hold the
// ORDERED quantity, so a short-shipped PO makes expected use read high.
// Corrugated cartons are used by no SKU, so they have no expected figure.

const inputCls = 'w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30';
const COLS = 6;

const gapClass = (r) => {
  if (r.gap_pcs == null || !r.expected_pcs) return 'text-gray-400';
  const pct = Math.abs(r.gap_pct ?? 0);
  if (pct >= 10) return 'font-semibold text-[#c1121f]';
  if (pct >= 5) return 'font-medium text-amber-700';
  return 'text-green-700';
};

export default function CrossCheckTab() {
  const [draft, setDraft] = useState(() => ({ from: istDate(-6), to: istDate(0) }));
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  // State is only set in the promise callbacks, so the mount effect can call
  // this directly; `load` adds the synchronous loading flag for later fetches.
  const fetchData = (w = draft) => getCrossCheck({ from: w.from || undefined, to: w.to || undefined })
    .then(setData)
    .catch((err) => toast.error(toastMessage(err, 'Could not load the cross-check')))
    .finally(() => setLoading(false));
  const load = (w) => { setLoading(true); return fetchData(w); };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { fetchData(); }, []);

  const rows = data?.rows || [];
  const withUsage = rows.filter((r) => r.has_usage);
  const without = rows.filter((r) => !r.has_usage);

  return (
    <div className="space-y-4">
      <section className="bg-white rounded-xl border border-gray-200">
        <form onSubmit={(e) => { e.preventDefault(); load(); }} className="flex flex-wrap items-end gap-3 p-4 border-b border-gray-100">
          <label className="block w-40">
            <span className="block text-xs font-medium text-gray-600 mb-1">From</span>
            <input type="date" value={draft.from} onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))} className={inputCls} />
          </label>
          <label className="block w-40">
            <span className="block text-xs font-medium text-gray-600 mb-1">To</span>
            <input type="date" value={draft.to} onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))} className={inputCls} />
          </label>
          <Button type="submit" variant="secondary">Check</Button>
          {data && (
            <p className="text-sm text-gray-600 basis-full sm:basis-auto sm:ml-auto">
              {fmt(data.counts_closed)} count{data.counts_closed !== 1 ? 's' : ''} closed in this window.
              {data.unlinked_lines > 0 && (
                <span className="text-amber-700"> {fmt(data.unlinked_lines)} dispatched PO line{data.unlinked_lines !== 1 ? 's' : ''} link to no SKU usage, so expected use reads low.</span>
              )}
            </p>
          )}
        </form>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-gray-50 text-left text-xs font-semibold text-gray-600 uppercase tracking-wide">
              <tr>
                <th className="px-4 py-3">Article</th>
                <th className="px-4 py-3 text-right">Went Out (packs)</th>
                <th className="px-4 py-3 text-right">Went Out (pcs)</th>
                <th className="px-4 py-3 text-right">Dispatches used</th>
                <th className="px-4 py-3 text-right">Gap (pcs)</th>
                <th className="px-4 py-3 text-right">Gap</th>
              </tr>
            </thead>
            <tbody>
              {loading && Array.from({ length: 4 }).map((_, i) => (
                <tr key={`sk-${i}`} className="border-b border-gray-100">
                  {Array.from({ length: COLS }).map((__, j) => <td key={j} className="px-4 py-3"><div className="h-4 bg-gray-100 rounded animate-pulse" /></td>)}
                </tr>
              ))}
              {!loading && withUsage.map((r) => (
                <tr key={r.article_id} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="px-4 py-3 text-[#003049] font-medium">{r.article}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{fmt(r.out_packs)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{fmt(r.out_pcs)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">~{fmt(r.expected_pcs)}</td>
                  <td className={`px-4 py-3 text-right tabular-nums ${gapClass(r)}`}>{r.gap_pcs > 0 ? '+' : ''}{fmt(r.gap_pcs)}</td>
                  <td className={`px-4 py-3 text-right tabular-nums ${gapClass(r)}`}>{r.gap_pct == null ? '—' : `${r.gap_pct > 0 ? '+' : ''}${r.gap_pct}%`}</td>
                </tr>
              ))}
              {!loading && without.map((r) => (
                <tr key={r.article_id} className="border-b border-gray-100 hover:bg-gray-50 text-gray-500">
                  <td className="px-4 py-3">{r.article}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{fmt(r.out_packs)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{fmt(r.out_pcs)}</td>
                  <td className="px-4 py-3 text-right" colSpan={3}>no expected-use data — no SKU uses this article</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && !rows.length && <p className="text-center text-sm text-gray-500 py-10">No article has stickers yet.</p>}
        </div>
      </section>

      <p className="text-xs text-gray-500">
        A positive gap means more went Out than dispatches explain — possible loss, or packaging used outside dispatch.
        Compare over a week: packing happens before dispatch, and a part-used pack only goes Out once it is empty.
        Expected use is from the ordered quantity on each PO, so a short-shipped PO makes it read high.
      </p>
    </div>
  );
}
