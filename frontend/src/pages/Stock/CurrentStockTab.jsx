import { useEffect, useState } from 'react';
import * as XLSX from 'xlsx';
import toast from 'react-hot-toast';
import { Download } from 'lucide-react';
import Button from '../../components/ui/Button';
import { getStockSummary, listStockStickers } from '../../api/stock.api';
import { formatDate } from '../../utils/formatters';
import { articleText, fmt, toastMessage } from './stockHelpers';

// Current stock: one row per article and floor. A pack sits on the floor it
// was last scanned on (its sticker's floor if it has never been counted).
// Packs scanned today are In Stock already -- an evening delivery shows the
// moment it is scanned -- while Out moves only when a day finishes at midnight.
// Pieces are pack size x packs, so a part-used pack counts in full until its
// sticker stops being scanned.
//
// ADMIN/OWNER get a Download XLSX: sheet "Stock" is this table (with the
// floor filter applied), sheet "Stickers" the packs behind it, one row per
// sticker WITH its key (/api/stock/keys, Admin-only -- staff never see keys).

const COLS = 7;

// Local multi-sheet variant of the house XLSX helper (frontend/CLAUDE.md: the
// helper is duplicated per page by design). Each sheet is { name, columns,
// rows }; a column reads r[key], or get(r) when it has one.
function downloadSheets(filename, sheets) {
  const wb = XLSX.utils.book_new();
  for (const s of sheets) {
    const header = s.columns.map((c) => c.header);
    const data = s.rows.map((r) => s.columns.map((c) => {
      const v = c.get ? c.get(r) : r[c.key];
      return v == null ? '' : v;
    }));
    const ws = XLSX.utils.aoa_to_sheet([header, ...data]);
    ws['!cols'] = s.columns.map((c) => ({ wch: c.wch || 20 }));
    XLSX.utils.book_append_sheet(wb, ws, s.name);
  }
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
  XLSX.writeFile(wb, `${filename}-${stamp}.xlsx`);
}

// Numbers stay numbers, so the sheet can be summed and filtered.
const STOCK_COLUMNS = [
  { header: 'Article', get: articleText, wch: 40 },
  { header: 'Floor', key: 'floor_name' },
  { header: 'In stock (packs)', key: 'in_stock_packs', wch: 16 },
  { header: 'In stock (pcs)', key: 'in_stock_pcs', wch: 16 },
  { header: 'Unit', key: 'unit_metric', wch: 8 },
  { header: 'Went Out on last count (packs)', key: 'out_last_packs', wch: 28 },
  { header: 'Went Out on last count (pcs)', key: 'out_last_pcs', wch: 28 },
  { header: 'Not yet counted (packs)', key: 'not_counted_packs', wch: 22 },
  { header: 'Not yet counted (pcs)', key: 'not_counted_pcs', wch: 22 },
  { header: 'Wrong floor (packs)', key: 'flagged_packs', wch: 18 },
];

const STATUS_TEXT = { in_stock: 'In stock', not_counted: 'Not yet counted', out: 'Went Out on last count' };

// Days are YYYY-MM-DD (IST), so they sort and filter as text in Excel.
const STICKER_COLUMNS = [
  { header: 'Key', key: 'label_key', wch: 12 },
  { header: 'Status', get: (s) => STATUS_TEXT[s.status] || s.status, wch: 22 },
  { header: 'Article', get: articleText, wch: 40 },
  { header: 'Floor', get: (s) => s.seen_floor_name || s.sticker_floor_name },
  { header: 'Sticker floor', key: 'sticker_floor_name' },
  { header: 'Wrong floor', get: (s) => (s.wrong_floor ? 'Yes' : ''), wch: 12 },
  { header: 'Vendor', key: 'vendor_name', wch: 24 },
  { header: 'Entry #', key: 'batch_id', wch: 9 },
  { header: 'Label', get: (s) => `${s.label_no} of ${s.label_count}`, wch: 10 },
  { header: 'Pack size', key: 'pack_size', wch: 10 },
  { header: 'Unit', key: 'unit_metric', wch: 8 },
  { header: 'Last seen', key: 'last_seen', wch: 12 },
  { header: 'First seen', key: 'first_seen', wch: 12 },
  { header: 'Went Out on', key: 'out_on', wch: 12 },
  { header: 'Stickered on', key: 'stickered_on', wch: 13 },
];

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export default function CurrentStockTab({ isAdmin }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [floorFilter, setFloorFilter] = useState('');
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    getStockSummary()
      .then(setData)
      .catch((err) => toast.error(toastMessage(err, 'Could not load stock')))
      .finally(() => setLoading(false));
  }, []);

  const onFloor = (r) => !floorFilter || r.floor_id === Number(floorFilter);
  const rows = (data?.rows || []).filter(onFloor);
  const floors = [...new Map((data?.rows || []).map((r) => [r.floor_id, r.floor_name])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1]));
  const t = data?.totals;

  // Both sheets are fetched fresh at the same moment, so they agree with each
  // other (and the table is refreshed to match the file).
  const download = async () => {
    setExporting(true);
    try {
      const [summary, stickers] = await Promise.all([
        getStockSummary(),
        listStockStickers(floorFilter ? { floor_id: Number(floorFilter) } : {}),
      ]);
      setData(summary);
      const stockRows = summary.rows.filter(onFloor);
      if (!stockRows.length && !stickers.rows.length) { toast('Nothing to download yet'); return; }
      const floorName = floorFilter ? floors.find(([id]) => id === Number(floorFilter))?.[1] : null;
      downloadSheets(floorName ? `current-stock-${slug(floorName)}` : 'current-stock', [
        { name: 'Stock', columns: STOCK_COLUMNS, rows: stockRows },
        { name: 'Stickers', columns: STICKER_COLUMNS, rows: stickers.rows },
      ]);
    } catch (err) {
      toast.error(toastMessage(err, 'Download failed'));
    } finally {
      setExporting(false);
    }
  };

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
              ? <>Last full count: {formatDate(data.latest_count.count_date)}.</>
              : 'No day has finished yet — Out shows from the day after the first count.'}
            {data?.today && (
              <span className="ml-1 text-gray-500">
                {fmt(data.today.scanned)} pack{data.today.scanned !== 1 ? 's' : ''} scanned so far today (already in stock here).
              </span>
            )}
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <label className="block w-48">
              <span className="block text-xs font-medium text-gray-600 mb-1">Floor</span>
              <select value={floorFilter} onChange={(e) => setFloorFilter(e.target.value)} className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30">
                <option value="">All floors</option>
                {floors.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </select>
            </label>
            {isAdmin && (
              <Button
                variant="outline"
                onClick={download}
                loading={exporting}
                disabled={loading}
                title="Two sheets: this table, and every pack behind it with its sticker key (Admin/Owner only)"
              >
                <Download size={16} />Download XLSX
              </Button>
            )}
          </div>
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
