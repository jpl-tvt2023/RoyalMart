import { useState } from 'react';
import AppShell from '../../components/layout/AppShell';
import MasterTab from './MasterTab';
import OutboundProductsTab from './OutboundProductsTab';
import {
  listCities,   createCity,   updateCity,   deleteCity,
} from '../../api/cities.api';
import {
  listVendors, createVendor, updateVendor, deleteVendor,
} from '../../api/vendors.api';
import {
  listCouriers, createCourier, updateCourier, deleteCourier,
} from '../../api/couriers.api';
import {
  listCategories, createCategory, updateCategory, deleteCategory,
} from '../../api/categories.api';

const TABS = [
  { key: 'cities',     label: 'Cities' },
  { key: 'vendors',    label: 'Vendors' },
  { key: 'couriers',   label: 'Courier Partners' },
  { key: 'categories', label: 'Categories' },
  { key: 'outboundProducts', label: 'Outbound Product List' },
];

export default function ConfigurationsPage() {
  const [tab, setTab] = useState('cities');

  return (
    <AppShell>
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-[#003049]">Configurations</h1>
        <p className="text-gray-500 text-sm">Master data for cities, vendors, courier partners, categories, and the outbound product list</p>
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

      {tab === 'cities' && (
        <MasterTab
          label="City"
          labelPlural="cities"
          entityType="city"
          listFn={listCities}
          createFn={createCity}
          updateFn={updateCity}
          deleteFn={deleteCity}
        />
      )}
      {tab === 'vendors' && (
        <MasterTab
          label="Vendor"
          labelPlural="vendors"
          entityType="vendor"
          listFn={listVendors}
          createFn={createVendor}
          updateFn={updateVendor}
          deleteFn={deleteVendor}
          extraColumn={{
            header: 'Parser',
            render: (row) => row.has_parser
              ? <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-50 text-green-700 border border-green-200">Implemented</span>
              : <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200">Not implemented</span>,
          }}
        />
      )}
      {tab === 'couriers' && (
        <MasterTab
          label="Courier"
          labelPlural="couriers"
          entityType="courier"
          listFn={listCouriers}
          createFn={createCourier}
          updateFn={updateCourier}
          deleteFn={deleteCourier}
        />
      )}
      {tab === 'categories' && (
        <MasterTab
          label="Category"
          labelPlural="categories"
          entityType="category"
          listFn={listCategories}
          createFn={createCategory}
          updateFn={updateCategory}
          deleteFn={deleteCategory}
        />
      )}
      {tab === 'outboundProducts' && <OutboundProductsTab />}
    </AppShell>
  );
}
