import axios from 'axios';

// Falls back to the same-origin '/api' proxy (see vercel.json / vite.config.js)
// when unset, so behavior is unchanged unless VITE_API_BASE_URL is configured
// for the current deployment (e.g. a Preview environment pointing at a
// separate backend + test database).
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

const api = axios.create({
  baseURL: API_BASE_URL,
  withCredentials: true,
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('accessToken');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Endpoints that establish or renew the session themselves. A 401 from one of
// these IS the answer — "wrong password", "your session is gone" — not a stale
// access token. Running them back through /auth/refresh only buries the message
// the user needs to see.
const AUTH_ENDPOINTS = ['/auth/login', '/auth/refresh', '/auth/change-password'];
const isAuthEndpoint = (url = '') => AUTH_ENDPOINTS.some(path => url.includes(path));

// The session is unrecoverable. Drop both halves of it — leaving an orphaned
// `user` key behind makes AuthContext's boot check half-true — and send the user
// to the login screen. Never reload the login screen itself: that wipes the
// toast explaining why they landed there, which reads as "I clicked Sign In and
// nothing happened".
function endSession() {
  localStorage.removeItem('accessToken');
  localStorage.removeItem('user');
  if (window.location.pathname !== '/login') {
    window.location.href = '/login';
  }
}

let isRefreshing = false;
let failedQueue = [];

function processQueue(error, token = null) {
  failedQueue.forEach(({ resolve, reject }) => {
    if (error) reject(error);
    else resolve(token);
  });
  failedQueue = [];
}

api.interceptors.response.use(
  (res) => res,
  async (error) => {
    const original = error.config;

    // Hand everything we can't fix straight back to the caller so its own
    // catch block can surface the real message: network errors with no config,
    // non-401s, the auth endpoints above, and anything already retried once.
    if (
      !original ||
      error.response?.status !== 401 ||
      isAuthEndpoint(original.url) ||
      original._retry
    ) {
      return Promise.reject(error);
    }

    original._retry = true;

    if (isRefreshing) {
      return new Promise((resolve, reject) => {
        failedQueue.push({ resolve, reject });
      }).then((token) => {
        original.headers.Authorization = `Bearer ${token}`;
        return api(original);
      });
    }

    isRefreshing = true;
    try {
      const { data } = await axios.post(`${API_BASE_URL}/auth/refresh`, {}, { withCredentials: true });
      localStorage.setItem('accessToken', data.accessToken);
      processQueue(null, data.accessToken);
      original.headers.Authorization = `Bearer ${data.accessToken}`;
      return api(original);
    } catch (err) {
      processQueue(err, null);
      endSession();
      return Promise.reject(err);
    } finally {
      isRefreshing = false;
    }
  }
);

export default api;
