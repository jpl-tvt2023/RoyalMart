import axios from 'axios';

// The public Barcode Station's API client (/api/station, migration 098).
//
// Deliberately NOT the shared instance in ./axios.js: that one attaches the
// portal login token and, on a 401, tries /auth/refresh and then hard-redirects
// to /login -- which would bounce warehouse staff, who have no login, off the
// station. This instance carries the station's own device token instead, and a
// 401 just drops that token and tells the page to show the PIN screen.

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

const TOKEN_KEY = 'roms:barcodeStation:token';
const OPERATOR_KEY = 'roms:barcodeStation:operator';

// Storage can throw (private windows, blocked site data) -- the station then
// still works for the session, it just forgets on reload.
function read(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch { /* ignore */ }
}

export const getStationToken = () => read(TOKEN_KEY);
export const setStationToken = (token) => write(TOKEN_KEY, token);
export const getOperator = () => read(OPERATOR_KEY) || '';
export const setOperator = (name) => write(OPERATOR_KEY, name);

const station = axios.create({ baseURL: `${API_BASE_URL}/station`, withCredentials: false });

station.interceptors.request.use((config) => {
  const token = getStationToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// One listener: the mounted station page (or print page).
let signedOutListener = null;
export function onStationSignedOut(fn) {
  signedOutListener = fn;
  return () => { if (signedOutListener === fn) signedOutListener = null; };
}

station.interceptors.response.use(
  (res) => res,
  (error) => {
    const url = error.config?.url || '';
    if (error.response?.status === 401 && !url.includes('/session')) {
      setStationToken(null);
      if (signedOutListener) signedOutListener(error.response.data || {});
    }
    return Promise.reject(error);
  }
);

export function endStationSession() {
  setStationToken(null);
}

export async function startStationSession(pin) {
  const { data } = await station.post('/session', { pin });
  setStationToken(data.token);
  return data;
}

// Also refreshes the device token (sliding 90-day expiry).
export async function getStationOptions() {
  const { data } = await station.get('/options');
  if (data?.token) setStationToken(data.token);
  return data;
}

export async function listLabelBatches(params) {
  const { data } = await station.get('/batches', { params });
  return data;
}

export async function createLabelBatch(payload) {
  const { data } = await station.post('/batches', payload);
  return data;
}

export async function updateLabelBatch(id, payload) {
  const { data } = await station.patch(`/batches/${id}`, payload);
  return data;
}

// A generated batch needs a reason (099), a draft does not.
export async function deleteLabelBatch(id, operator, reason) {
  const { data } = await station.delete(`/batches/${id}`, { data: { operator, reason } });
  return data;
}

export async function generateLabelBatch(id, operator) {
  const { data } = await station.post(`/batches/${id}/generate`, { operator });
  return data;
}

// { batch, keys: [{ label_no, label_key }] }, optionally a from/to slice.
export async function getLabelBatchKeys(id, params) {
  const { data } = await station.get(`/batches/${id}/keys`, { params });
  return data;
}

// { label_key, label_no, batch }
export async function findLabelKey(key) {
  const { data } = await station.get(`/keys/${encodeURIComponent(key)}`);
  return data;
}
