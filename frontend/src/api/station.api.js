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

// Drafts only: a generated batch is final.
export async function deleteLabelBatch(id, operator) {
  const { data } = await station.delete(`/batches/${id}`, { data: { operator } });
  return data;
}

export async function generateLabelBatch(id, operator) {
  const { data } = await station.post(`/batches/${id}/generate`, { operator });
  return data;
}

// Logs the print and returns what to print -- { batch, keys, label } -- for
// PrintPortal, which renders it off-screen. The station's only way to keys:
// viewing them is Admin-only (labelBatches.api.js). range = { from?, to? }.
export async function printLabelBatch(id, operator, range = {}) {
  const { data } = await station.post(`/batches/${id}/print`, { operator, ...range });
  return data;
}

// { label_key, label_no, batch }
export async function findLabelKey(key) {
  const { data } = await station.get(`/keys/${encodeURIComponent(key)}`);
  return data;
}

// ---- Stock counts (migrations 102, 103) -----------------------------------
// The count is the IST day: no start, no close -- the day's first scan creates
// it, midnight finishes it. The station never learns whether a pack was Out --
// missed scans are Admin/Owner only, in the portal (stock.api.js).

// { today, count, progress, last_finished } -- count is null before the day's
// first scan.
export async function getTodayCount() {
  const { data } = await station.get('/counts/today');
  return data;
}

// { results: [{ key, status, pack?, moved_from? }], scanned, floor, count }
// status: counted | moved | already_counted | unknown. The scan puts the pack
// on `floor`: moved_from names the floor it was on before, when that was
// another one (a same-day rescan elsewhere answers `moved`). Re-sending is
// harmless. The server puts the scans into TODAY's count.
export async function sendScans({ operator, floor_id, keys }) {
  const { data } = await station.post('/counts/today/scans', { operator, floor_id, keys });
  return data;
}
