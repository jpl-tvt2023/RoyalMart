import api from './axios';

// The warehouses master (migration 096): our own stock locations, each a tab on
// the Stitching page and a place goods can be sent or booked into. Reads are
// open to every logged-in user because the Stitching page builds its tabs from
// it and the challan and receipt forms their warehouse choices; writes are
// Admin/Owner only, enforced server-side.
export async function listWarehouses() {
  const { data } = await api.get('/configurations/warehouses');
  return data;
}

// Takes the warehouse's first incoming prefix too ({ name, code, prefix }) --
// the server writes both together, since a warehouse with no prefix could not
// take a single lot.
export async function createWarehouse(payload) {
  const { data } = await api.post('/configurations/warehouses', payload);
  return data;
}

export async function updateWarehouse(id, payload) {
  const { data } = await api.patch(`/configurations/warehouses/${id}`, payload);
  return data;
}

export async function deleteWarehouse(id) {
  const { data } = await api.delete(`/configurations/warehouses/${id}`);
  return data;
}
