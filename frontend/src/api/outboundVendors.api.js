import api from './axios';

export async function listOutboundVendors() {
  const { data } = await api.get('/outbound-vendors');
  return data;
}

export async function createOutboundVendor(payload) {
  const { data } = await api.post('/outbound-vendors', payload);
  return data;
}

export async function updateOutboundVendor(id, payload) {
  const { data } = await api.patch(`/outbound-vendors/${id}`, payload);
  return data;
}

export async function deleteOutboundVendor(id) {
  const { data } = await api.delete(`/outbound-vendors/${id}`);
  return data;
}
