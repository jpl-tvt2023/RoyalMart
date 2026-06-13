/**
 * A compact legend explaining row/cell highlight colours on a page.
 *
 * Usage:
 *   <Legend items={[
 *     { swatch: 'bg-red-200/70',   label: 'Expired' },
 *     { swatch: 'bg-amber-200/70', label: 'Expiring soon' },
 *   ]} />
 *
 * `swatch` is a Tailwind background class (reuse the same class that drives the
 * actual highlight so the legend can never drift from reality).
 */
export default function Legend({ items = [], className = '' }) {
  if (!items.length) return null;
  return (
    <div className={`flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-gray-500 ${className}`}>
      <span className="font-medium text-gray-400">Legend:</span>
      {items.map(it => (
        <span key={it.label} className="flex items-center gap-1.5">
          <span className={`inline-block w-3 h-3 rounded-sm border border-black/10 ${it.swatch}`} />
          {it.label}
        </span>
      ))}
    </div>
  );
}
