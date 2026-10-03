import api from './axios';

// The RTV page (migration 092). Rows are opened by a GRN save, never here.
export async function listRtv(params) {
  const { data } = await api.get('/rtv', { params });
  return data;
}

// Per-vendor badges for the tabs, scoped by every other filter.
export async function getRtvCountsByVendor(params) {
  const { data } = await api.get('/rtv/counts-by-vendor', { params });
  return data;
}

export async function updateRtv(id, body) {
  const { data } = await api.patch(`/rtv/${id}`, body);
  return data;
}
