import AppShell from '../../components/layout/AppShell';
import { useSessionState } from '../../hooks/useSessionState';
import { useRBAC } from '../../hooks/useRBAC';
import CurrentStockTab from './CurrentStockTab';
import CountsTab from './CountsTab';
import MissedScansTab from './MissedScansTab';
import CrossCheckTab from './CrossCheckTab';

// Stock from the daily counts on the Barcode Station (migration 102).
//
// Nothing records goods leaving, so stock is read off the counts: a pack seen
// on an earlier count and missing from a closed one is Out at once; one that
// turns up again goes back into stock, and the gap is a MISSED SCAN.
//
// Everyone logged in sees the stock and each count's results. Missed scans
// (the scanner's mistakes) and the cross-check against dispatches are
// Admin/Owner only -- hidden here, and refused by the server for anyone else.

const TABS = [
  { key: 'current', label: 'Current stock', subtitle: 'What the last count found, by article and floor', admin: false },
  { key: 'counts', label: 'Counts', subtitle: 'Every closed count: what was found, what is new, what went Out', admin: false },
  { key: 'missed', label: 'Missed scans', subtitle: 'Packs a count missed that turned up again later — Admin/Owner only', admin: true },
  { key: 'cross', label: 'Cross-check', subtitle: 'Pieces Out against what dispatched POs should have used — Admin/Owner only', admin: true },
];

export default function StockPage() {
  const { isAdmin } = useRBAC();
  const [storedTab, setTab] = useSessionState('stock.tab', 'current');
  const tabs = TABS.filter((t) => !t.admin || isAdmin);
  const current = tabs.find((t) => t.key === storedTab) || tabs[0];

  return (
    <AppShell>
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-[#003049]">Stock</h1>
        <p className="text-gray-500 text-sm">{current.subtitle}</p>
      </div>

      <div className="flex gap-1 mb-4 border-b border-gray-200 overflow-x-auto">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap ${
              current.key === t.key ? 'border-[#c1121f] text-[#c1121f]' : 'border-transparent text-gray-500 hover:text-[#003049]'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Keyed so a tab switch remounts rather than reusing the last tab's rows. */}
      {current.key === 'current' && <CurrentStockTab key="current" />}
      {current.key === 'counts' && <CountsTab key="counts" isAdmin={isAdmin} />}
      {current.key === 'missed' && isAdmin && <MissedScansTab key="missed" />}
      {current.key === 'cross' && isAdmin && <CrossCheckTab key="cross" />}
    </AppShell>
  );
}
