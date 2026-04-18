import api from './axios';

export async function parsePreview(file, vendor) {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('vendor', vendor);
  const { data } = await api.post('/marketplace-pos/parse', fd);
  return data;
}

export async function listPOs(params = {}) {
  const { data } = await api.get('/marketplace-pos', { params });
  return data;
}

export async function getPO(poId) {
  const { data } = await api.get(`/marketplace-pos/${poId}`);
  return data;
}

export async function commitPO(payload) {
  const { data } = await api.post('/marketplace-pos', payload);
  return data;
}

export async function updatePO(poId, payload) {
  const { data } = await api.patch(`/marketplace-pos/${poId}`, payload);
  return data;
}

export async function deletePO(poId) {
  const { data } = await api.delete(`/marketplace-pos/${poId}`);
  return data;
}
