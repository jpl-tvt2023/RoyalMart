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

// ── Outbound (packaging/barcode demand) ─────────────────────────────────────

export async function getOutboundDefaults() {
  const { data } = await api.get('/procurement/outbound/defaults');
  return data;
}

export async function getOutboundRequirements(params = {}) {
  const { data } = await api.get('/procurement/outbound/requirements', { params });
  return data;
}

export async function getOutboundVendorCounts(params = {}) {
  const { data } = await api.get('/procurement/outbound/vendor-counts', { params });
  return data;
}

export async function markPackagingOrdered(payload) {
  const { data } = await api.post('/procurement/outbound/mark-ordered', payload);
  return data;
}

export async function listPackagingBatches() {
  const { data } = await api.get('/procurement/outbound/batches');
  return data;
}

export async function undoPackagingBatch(id) {
  const { data } = await api.delete(`/procurement/outbound/batches/${id}`);
  return data;
}
