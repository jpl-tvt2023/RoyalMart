import AppShell from '../../components/layout/AppShell';
import { useSessionState } from '../../hooks/useSessionState';
import InboundTab from './InboundTab';
import OutboundTab from './OutboundTab';

const TOP_TABS = [
  { key: 'raw', label: 'Raw Material' },
  { key: 'packaging', label: 'Packaging Material' },
  { key: 'barcode', label: 'Barcode' },
];

const SUBTITLES = {
  raw: "Raw materials required per PO. Total counts only POs you haven't ordered for yet.",
  packaging: "Packaging products required per PO. Total counts only POs you haven't ordered for yet.",
  barcode: "Barcodes required per PO. Total counts only POs you haven't ordered for yet.",
};

export default function ProcurementPage() {
  // Key bumped to .v2 because the tab keys changed: a remembered 'inbound' /
  // 'outbound' from the old key matches no tab and would render nothing.
  const [topTab, setTopTab] = useSessionState('procurement.topTab.v2', 'raw');

  return (
    <AppShell>
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-[#003049]">Procurement Status</h1>
        <p className="text-gray-500 text-sm">{SUBTITLES[topTab]}</p>
      </div>

      <div className="flex gap-1 mb-4 border-b border-gray-200">
        {TOP_TABS.map(t => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTopTab(t.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${topTab === t.key ? 'border-[#c1121f] text-[#c1121f]' : 'border-transparent text-gray-500 hover:text-[#003049]'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {topTab === 'raw' && <InboundTab />}
      {/* Keyed so switching tabs remounts rather than reusing the other kind's
          loaded matrix while the new one is still in flight. */}
      {topTab === 'packaging' && <OutboundTab key="packaging" kind="packaging" />}
      {topTab === 'barcode' && <OutboundTab key="barcode" kind="barcode" />}
    </AppShell>
  );
}
