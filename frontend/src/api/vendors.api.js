import api from './axios';

export async function listVendors() {
  const { data } = await api.get('/configurations/vendors');
  return data;
}

export async function createVendor(payload) {
  const { data } = await api.post('/configurations/vendors', payload);
  return data;
}

export async function updateVendor(id, payload) {
  const { data } = await api.patch(`/configurations/vendors/${id}`, payload);
  return data;
}

export async function deleteVendor(id) {
  const { data } = await api.delete(`/configurations/vendors/${id}`);
  return data;
}
