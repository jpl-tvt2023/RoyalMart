import api from './axios';

export async function listOutboundPOs(params) {
  const { data } = await api.get('/outbound-pos', { params });
  return data;
}

export async function getOutboundPO(id) {
  const { data } = await api.get(`/outbound-pos/${id}`);
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
