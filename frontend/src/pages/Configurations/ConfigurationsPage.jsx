import { useState } from 'react';
import AppShell from '../../components/layout/AppShell';
import MasterTab from './MasterTab';
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
];

// A vendor's PO Prefix (migration 097): the letters its PO ids start with --
// MY gives MY001. One to three letters, unique; the server is the authority
// (vendors.controller.js) and refuses a change once the vendor has POs.
const VENDOR_PO_PREFIX = {
  key: 'po_prefix',
  label: 'PO Prefix',
  required: true,
  placeholder: 'e.g. MY',
  normalize: (v) => String(v || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3),
  defaultFrom: (name) => String(name || '').trim().charAt(0),
  lockedWhen: (row) => !!(row.has_pos && row.po_prefix),
  hint: 'Letters this vendor’s PO ids start with — MY gives MY001. Must be unused by any other vendor.',
  lockedHint: 'Fixed — this vendor already has POs numbered with it.',
};

export default function ConfigurationsPage() {
  const [tab, setTab] = useState('cities');

  return (
    <AppShell>
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-[#003049]">Configurations</h1>
        <p className="text-gray-500 text-sm">Master data for cities, vendors, courier partners and categories</p>
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
          extraField={VENDOR_PO_PREFIX}
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
    </AppShell>
  );
}
