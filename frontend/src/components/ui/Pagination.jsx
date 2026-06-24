import { ChevronLeft, ChevronRight } from 'lucide-react';

const PAGE_SIZES = [10, 25, 50, 100];

export default function Pagination({ page, pageSize, total, onPageChange, onPageSizeChange, leftExtra }) {
  const totalPages = Math.max(1, Math.ceil((total || 0) / pageSize));
  const safePage = Math.min(Math.max(1, page || 1), totalPages);
  const start = total === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const end = Math.min(safePage * pageSize, total || 0);

  const windowStart = Math.max(1, safePage - 2);
  const windowEnd = Math.min(totalPages, safePage + 2);
  const numbers = [];
  for (let p = windowStart; p <= windowEnd; p++) numbers.push(p);

  return (
    <div className="flex items-center justify-between flex-wrap gap-3 px-4 py-3 border-t border-gray-200 bg-white text-sm">
      <div className="flex items-center gap-3 text-gray-600">
        <span>Showing <span className="font-medium text-[#003049]">{start}–{end}</span> of <span className="font-medium text-[#003049]">{total || 0}</span></span>
        <span className="text-gray-300">·</span>
        <label className="flex items-center gap-2">
          Per page
          <select
            value={pageSize}
            onChange={e => onPageSizeChange(Number(e.target.value))}
            className="border border-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30"
          >
            {PAGE_SIZES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        {leftExtra && (
          <>
            <span className="text-gray-300">·</span>
            {leftExtra}
          </>
        )}
      </div>

      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => onPageChange(safePage - 1)}
          disabled={safePage <= 1}
          className="p-1.5 rounded hover:bg-gray-100 text-gray-600 disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <ChevronLeft size={16} />
        </button>
        {windowStart > 1 && (
          <>
            <PageBtn n={1} active={safePage === 1} onClick={() => onPageChange(1)} />
            {windowStart > 2 && <span className="px-1 text-gray-400">…</span>}
          </>
        )}
        {numbers.map(n => (
          <PageBtn key={n} n={n} active={n === safePage} onClick={() => onPageChange(n)} />
        ))}
        {windowEnd < totalPages && (
          <>
            {windowEnd < totalPages - 1 && <span className="px-1 text-gray-400">…</span>}
            <PageBtn n={totalPages} active={safePage === totalPages} onClick={() => onPageChange(totalPages)} />
          </>
        )}
        <button
          type="button"
          onClick={() => onPageChange(safePage + 1)}
          disabled={safePage >= totalPages}
          className="p-1.5 rounded hover:bg-gray-100 text-gray-600 disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
}

function PageBtn({ n, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`min-w-[2rem] h-8 px-2 rounded text-sm ${active ? 'bg-[#003049] text-white' : 'text-gray-700 hover:bg-gray-100'}`}
    >
      {n}
    </button>
  );
}

export function loadPersistedPageSize(key, defaultSize = 25) {
  const stored = typeof window !== 'undefined' ? Number(localStorage.getItem(`pageSize:${key}`)) : 0;
  return PAGE_SIZES.includes(stored) ? stored : defaultSize;
}

export function persistPageSize(key, size) {
  if (typeof window !== 'undefined') localStorage.setItem(`pageSize:${key}`, String(size));
}
