import api from './axios';

// Stock from the daily counts (migration 102) -- /api/stock, portal login.
// Everyone logged in: summary, counts, a count's packs (never keys).
// Admin/Owner only (the server checks): missed scans, the cross-check, a
// sticker's history, reopening the latest count.

export async function getStockSummary(params) {
  const { data } = await api.get('/stock/summary', { params });
  return data;
}

export async function listStockCounts(params) {
  const { data } = await api.get('/stock/counts', { params });
  return data;
}

export async function getStockCount(id) {
  const { data } = await api.get(`/stock/counts/${id}`);
  return data;
}

// list: found | new | out | flagged
export async function listStockCountPacks(id, params) {
  const { data } = await api.get(`/stock/counts/${id}/packs`, { params });
  return data;
}

export async function reopenStockCount(id) {
  const { data } = await api.post(`/stock/counts/${id}/reopen`);
  return data;
}

export async function listMissedScans(params) {
  const { data } = await api.get('/stock/missed', { params });
  return data;
}

export async function listMissedPacks(countId, params) {
  const { data } = await api.get(`/stock/missed/${countId}`, { params });
  return data;
}

export async function getCrossCheck(params) {
  const { data } = await api.get('/stock/cross-check', { params });
  return data;
}

export async function getStickerHistory(key) {
  const { data } = await api.get(`/stock/keys/${encodeURIComponent(key)}`);
  return data;
}
