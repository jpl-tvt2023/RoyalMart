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

  const login = useCallback(async (email, password) => {
    const { data } = await apiLogin(email, password);
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
