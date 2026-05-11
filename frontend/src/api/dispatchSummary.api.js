import api from './axios';

// Dispatch Summary is a different operational view of the same marketplace_pos
// rows used by Order Summary, so it reuses the /order-summary endpoints.

export async function listDispatchSummary(params = {}) {
  const { data } = await api.get('/order-summary', { params });
  return data;
}

export async function updateDispatchRow(poId, payload) {
  const { data } = await api.patch(`/order-summary/${poId}`, payload);
  return data;
}

export async function bulkUpdateDispatch(payload) {
  const { data } = await api.patch('/order-summary/bulk', payload);
  return data;
}
