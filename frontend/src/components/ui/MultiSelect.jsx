import { useEffect, useRef } from 'react';
import { ChevronDown } from 'lucide-react';

// Checkbox dropdown for a multi-value filter — the Status and Flags filters on
// the Outbound PO list, and the Status filter on the Stitching page.
//
// Lived inside OutboundPOList while it was the only page with one. Moved here
// rather than copy-pasted a third time when Stitching needed the same control:
// GRNList still has its own older StatusMultiSelect, which is the duplication
// this is meant to stop growing.
//
// "All" is a plain master toggle and is never itself stored: it is derived from
// whether every option is selected, so ticking the options one by one lights it
// up on its own, and unticking it clears them all. An empty selection is a
// legitimate state meaning "nothing qualifies" — each caller's buildParams
// sends NONE_SELECTED for it, which the server turns into a false predicate.
export default function MultiSelect({
  options, selected, onChange, disabled, allLabel, labelOf = (v) => v,
}) {
  const detRef = useRef(null);
  useEffect(() => {
    const handler = (e) => {
      if (detRef.current?.open && !detRef.current.contains(e.target)) detRef.current.open = false;
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const allChecked = selected.length === options.length;
  const toggleAll = () => onChange(allChecked ? [] : [...options]);
  const toggle = (s) => onChange(
    selected.includes(s) ? selected.filter(x => x !== s) : [...selected, s]
  );

  const label = allChecked
    ? allLabel
    : (selected.length === 0 ? 'None selected' : `${selected.length} selected`);
  return (
    <details ref={detRef} className={`relative ${disabled ? 'pointer-events-none opacity-50' : ''}`}>
      <summary className="list-none cursor-pointer flex items-center justify-between w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30">
        <span className="text-gray-700 truncate">{label}</span>
        <ChevronDown size={14} className="text-gray-400 shrink-0" />
      </summary>
      <div className="absolute z-20 mt-1 w-60 bg-white border border-gray-200 rounded-lg shadow-lg p-1 max-h-64 overflow-auto">
        <label className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-gray-50 cursor-pointer text-sm border-b border-gray-100 mb-1">
          <input type="checkbox" checked={allChecked} onChange={toggleAll} />
          <span className="font-medium text-gray-700">{allLabel}</span>
        </label>
        {options.map(s => (
          <label key={s} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-gray-50 cursor-pointer text-sm">
            <input type="checkbox" checked={selected.includes(s)} onChange={() => toggle(s)} />
            <span className="text-gray-700">{labelOf(s)}</span>
          </label>
        ))}
      </div>
    </details>
  );
}
