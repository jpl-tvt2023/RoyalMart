import api from './axios';

export async function listOutboundCategories() {
  const { data } = await api.get('/configurations/outbound-categories');
  return data;
}

export async function createOutboundCategory(payload) {
  const { data } = await api.post('/configurations/outbound-categories', payload);
  return data;
}

export async function updateOutboundCategory(id, payload) {
  const { data } = await api.patch(`/configurations/outbound-categories/${id}`, payload);
  return data;
}

export async function deleteOutboundCategory(id) {
  const { data } = await api.delete(`/configurations/outbound-categories/${id}`);
  return data;
}
