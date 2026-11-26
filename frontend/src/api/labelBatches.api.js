import api from './axios';

// The Admin side of the Barcode Station (/api/label-batches): the only place
// barcode keys can be viewed. Portal login, Admin/Owner only -- the server
// refuses anyone else (401/403), whatever the browser claims about its user.
//
// Uses the shared portal instance on purpose: these calls are made only when
// the station runs in a browser logged into the portal as Admin/Owner.

// The station grid with each generated row's first keys as a preview.
export async function listLabelBatchesAdmin(params) {
  const { data } = await api.get('/label-batches', { params });
  return data;
}

// { batch, keys: [{ label_no, label_key }], label: { width_mm, height_mm } }
export async function getLabelBatchKeysAdmin(id, params) {
  const { data } = await api.get(`/label-batches/${id}/keys`, { params });
  return data;
}

// Logs an Admin's print (from/to optional) and returns the same shape as the
// keys call.
export async function printLabelBatchAdmin(id, range = {}) {
  const { data } = await api.post(`/label-batches/${id}/print`, range);
  return data;
}
