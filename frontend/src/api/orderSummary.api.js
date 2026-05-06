import api from './axios';

export async function listOrderSummary(params = {}) {
  const { data } = await api.get('/order-summary', { params });
  return data;
}

export async function updateOrderSummary(poId, payload) {
  const { data } = await api.patch(`/order-summary/${poId}`, payload);
  return data;
}

export async function bulkUpdateOrderSummary(payload) {
  const { data } = await api.patch('/order-summary/bulk', payload);
  return data;
}
