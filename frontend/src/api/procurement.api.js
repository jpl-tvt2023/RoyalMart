import api from './axios';

export async function getDefaults() {
  const { data } = await api.get('/procurement/defaults');
  return data;
}

export async function getRequirements(params = {}) {
  const { data } = await api.get('/procurement/requirements', { params });
  return data;
}

export async function getVendorCounts(params = {}) {
  const { data } = await api.get('/procurement/vendor-counts', { params });
  return data;
}

export async function markOrdered(payload) {
  const { data } = await api.post('/procurement/mark-ordered', payload);
  return data;
}

export async function listBatches() {
  const { data } = await api.get('/procurement/batches');
  return data;
}

export async function undoBatch(id) {
  const { data } = await api.delete(`/procurement/batches/${id}`);
  return data;
}
