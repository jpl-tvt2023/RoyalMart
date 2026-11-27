import api from './axios';

// Stock from the daily counts (migrations 102, 103) -- /api/stock, portal
// login. One count per IST day, finished at midnight -- nothing to reopen.
// Everyone logged in: summary, counts, a day's packs (never keys).
// Admin/Owner only (the server checks): missed scans, the cross-check, a
// sticker's history.

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

// ADMIN/OWNER: the packs behind the Current stock figures, one row per sticker
// WITH its key (In stock, Not yet counted, Went Out on the last count) -- for
// the Current stock XLSX download. params: { floor_id?, vendor_id? }; no
// page params = every row.
export async function listStockStickers(params) {
  const { data } = await api.get('/stock/keys', { params });
  return data;
}

export async function getStickerHistory(key) {
  const { data } = await api.get(`/stock/keys/${encodeURIComponent(key)}`);
  return data;
}
