import AppShell from '../../components/layout/AppShell';
import { useSessionState } from '../../hooks/useSessionState';
import InboundTab from './InboundTab';
import OutboundTab from './OutboundTab';

const TOP_TABS = [
  { key: 'inbound', label: 'Inbound' },
  { key: 'outbound', label: 'Outbound' },
];

export default function ProcurementPage() {
  const [topTab, setTopTab] = useSessionState('procurement.topTab', 'inbound');

  return (
    <AppShell>
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-[#003049]">Procurement Status</h1>
        <p className="text-gray-500 text-sm">
          {topTab === 'inbound'
            ? "Raw materials required per PO. Total counts only POs you haven't ordered for yet."
            : "Packaging products and barcodes required per PO. Total counts only POs you haven't ordered for yet."}
        </p>
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

      {topTab === 'inbound' ? <InboundTab /> : <OutboundTab />}
    </AppShell>
  );
}
