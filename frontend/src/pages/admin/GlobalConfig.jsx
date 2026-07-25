import AppShell from '../../components/layout/AppShell';
import MasterTab from '../Configurations/MasterTab';
import {
  listCompanies, createCompany, updateCompany, deleteCompany,
} from '../../api/companies.api';

export default function GlobalConfig() {
  return (
    <AppShell>
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-[#003049]">Global Config</h1>
        <p className="text-gray-500 text-sm">Company master data</p>
      </div>

      <MasterTab
        label="Company"
        labelPlural="companies"
        entityType="company"
        listFn={listCompanies}
        createFn={createCompany}
        updateFn={updateCompany}
        deleteFn={deleteCompany}
      />
    </AppShell>
  );
}
