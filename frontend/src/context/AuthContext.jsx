import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { login as apiLogin, logout as apiLogout } from '../api/auth.api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const stored = localStorage.getItem('user');
    const token = localStorage.getItem('accessToken');
    if (stored && token) {
      try { setUser(JSON.parse(stored)); }
      catch { localStorage.clear(); }
    }
    setLoading(false);
  }, []);

  const login = useCallback(async (username, password) => {
    const { data } = await apiLogin(username, password);

    // A 200 without a token means the backend wants a second factor
    // (`{ mfaRequired: true }`) — there is no TOTP prompt in this UI yet. Fail
    // loudly instead of storing `undefined`, which lands the *string*
    // "undefined" in localStorage; that is truthy in the request interceptor, so
    // every later call goes out as `Bearer undefined` and 401-loops in a way
    // that survives reloads until site data is cleared by hand.
    if (!data?.accessToken) {
      throw new Error(
        data?.mfaRequired
          ? 'This account has two-factor authentication enabled, which the portal does not support yet. Ask an admin to disable it.'
          : 'Login failed — unexpected response from the server.'
      );
    }

    localStorage.setItem('accessToken', data.accessToken);
    localStorage.setItem('user', JSON.stringify(data.user));
    setUser(data.user);
    return data.user;
  }, []);

  const logout = useCallback(async () => {
    try { await apiLogout(); } catch {}
    localStorage.removeItem('accessToken');
    localStorage.removeItem('user');
    setUser(null);
  }, []);

  const refreshUser = useCallback((updatedUser) => {
    const merged = { ...user, ...updatedUser };
    localStorage.setItem('user', JSON.stringify(merged));
    setUser(merged);
  }, [user]);

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
