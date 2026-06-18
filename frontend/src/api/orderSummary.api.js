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

export async function getOrderSummaryCountsByVendor(params = {}) {
  const { data } = await api.get('/order-summary/counts-by-vendor', { params });
  return data;
}

export async function getOrderSummaryCountsByPoc(params = {}) {
  const { data } = await api.get('/order-summary/counts-by-poc', { params });
  return data;
}

export async function getGrnAppointmentsByDate(date) {
  const { data } = await api.get('/order-summary/grn-appointments', { params: { date } });
  return data;
}
