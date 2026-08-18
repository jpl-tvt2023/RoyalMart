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

// ── Outbound (packaging / barcode demand) ───────────────────────────────────
//
// One set of endpoints serves both the Packaging Material and Barcode tabs,
// selected by `kind` ('packaging' | 'barcode'). The server defaults to
// 'packaging' when it is omitted.

export async function getOutboundDefaults(kind) {
  const { data } = await api.get('/procurement/outbound/defaults', { params: { kind } });
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

export async function listPackagingBatches(kind) {
  const { data } = await api.get('/procurement/outbound/batches', { params: { kind } });
  return data;
}

export async function undoPackagingBatch(id, kind) {
  const { data } = await api.delete(`/procurement/outbound/batches/${id}`, { params: { kind } });
  return data;
}
