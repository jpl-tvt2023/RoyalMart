import api from './axios';

export async function listLeadTime(params = {}) {
  const { data } = await api.get('/lead-time', { params });
  return data;
}

export async function getLeadTimeCountsByVendor(params = {}) {
  const { data } = await api.get('/lead-time/counts-by-vendor', { params });
  return data;
}
