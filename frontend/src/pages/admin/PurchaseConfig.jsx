import AppShell from '../../components/layout/AppShell';
import MasterTab from '../Configurations/MasterTab';
import PackagingCatalogTab from '../packaging/PackagingList';
import { useSessionState } from '../../hooks/useSessionState';
import {
  listCompanies, createCompany, updateCompany, deleteCompany,
} from '../../api/companies.api';

const TABS = [
  { key: 'global', label: 'Global' },
  { key: 'packagingItems', label: 'Packaging Items' },
];

const SUBTITLES = {
  global: 'Company master data',
  packagingItems: 'The master article catalog (Category · Item Name · Variant · Unit Metric) that outbound vendors map to and outbound POs draw from',
};

export default function PurchaseConfig() {
  const [tab, setTab] = useSessionState('purchaseConfig.tab', 'global');

  return (
    <AppShell>
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-[#003049]">Purchase Config</h1>
        <p className="text-gray-500 text-sm">{SUBTITLES[tab]}</p>
      </div>

      <div className="flex gap-1 mb-4 border-b border-gray-200">
        {TABS.map(t => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${tab === t.key ? 'border-[#c1121f] text-[#c1121f]' : 'border-transparent text-gray-500 hover:text-[#003049]'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'global' && (
        <MasterTab
          label="Company"
          labelPlural="companies"
          entityType="company"
          listFn={listCompanies}
          createFn={createCompany}
          updateFn={updateCompany}
          deleteFn={deleteCompany}
        />
      )}
      {tab === 'packagingItems' && <PackagingCatalogTab />}
    </AppShell>
  );
}
