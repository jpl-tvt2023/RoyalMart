import api from './axios';

// Balaji Builty (migration 108): hand-kept builty entries, ids P001, P002 ...

export async function listBalajiBuilty(params = {}) {
  const { data } = await api.get('/balaji-builty', { params });
  return data; // { rows, total, page, page_size }
}

// { all, vendors: [{ vendor, count }] } -- one tab per vendor, counted under the filters.
export async function getBalajiBuiltyTabs(params = {}) {
  const { data } = await api.get('/balaji-builty/tabs', { params });
  return data;
}

// { vendors, party_names, cities, couriers } -- values already used.
export async function getBalajiBuiltyOptions() {
  const { data } = await api.get('/balaji-builty/options');
  return data;
}

export async function createBalajiBuilty(payload) {
  const { data } = await api.post('/balaji-builty', payload);
  return data;
}

export async function updateBalajiBuilty(poId, payload) {
  const { data } = await api.patch(`/balaji-builty/${poId}`, payload);
  return data;
}

export async function deleteBalajiBuilty(poId) {
  const { data } = await api.delete(`/balaji-builty/${poId}`);
  return data;
}
