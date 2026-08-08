import api from './axios';

export async function listOutboundProducts() {
  const { data } = await api.get('/configurations/outbound-products');
  return data;
}

export async function createOutboundProduct(payload) {
  const { data } = await api.post('/configurations/outbound-products', payload);
  return data;
}

export async function updateOutboundProduct(id, payload) {
  const { data } = await api.patch(`/configurations/outbound-products/${id}`, payload);
  return data;
}

export async function deleteOutboundProduct(id) {
  const { data } = await api.delete(`/configurations/outbound-products/${id}`);
  return data;
}
