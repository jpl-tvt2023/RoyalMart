import api from './axios';

export async function listOutboundPOs(params) {
  const { data } = await api.get('/outbound-pos', { params });
  return data;
}

export async function getOutboundPO(id, { includeDeleted } = {}) {
  const { data } = await api.get(`/outbound-pos/${id}`, { params: includeDeleted ? { include_deleted: 1 } : undefined });
  return data;
}

export async function createOutboundPO(payload) {
  const { data } = await api.post('/outbound-pos', payload);
  return data;
}

export async function updateOutboundPO(id, payload) {
  const { data } = await api.patch(`/outbound-pos/${id}`, payload);
  return data;
}

export async function deleteOutboundPO(id) {
  const { data } = await api.delete(`/outbound-pos/${id}`);
  return data;
}

export async function restoreOutboundPO(id) {
  const { data } = await api.post(`/outbound-pos/${id}/restore`);
  return data;
}

export async function updateOutboundPOLineShort(poId, lineId, short) {
  const { data } = await api.patch(`/outbound-pos/${poId}/lines/${lineId}`, { short });
  return data;
}

export async function addOutboundPOLineReceipt(poId, lineId, payload) {
  const { data } = await api.post(`/outbound-pos/${poId}/lines/${lineId}/receipts`, payload);
  return data;
}

export async function updateOutboundPOLineReceipt(poId, lineId, receiptId, payload) {
  const { data } = await api.patch(`/outbound-pos/${poId}/lines/${lineId}/receipts/${receiptId}`, payload);
  return data;
}

export async function deleteOutboundPOLineReceipt(poId, lineId, receiptId) {
  const { data } = await api.delete(`/outbound-pos/${poId}/lines/${lineId}/receipts/${receiptId}`);
  return data;
}

export async function restoreOutboundPOLineReceipt(poId, lineId, receiptId) {
  const { data } = await api.post(`/outbound-pos/${poId}/lines/${lineId}/receipts/${receiptId}/restore`);
  return data;
}
