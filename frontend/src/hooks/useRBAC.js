import { useAuth } from '../context/AuthContext';

export const qualifiesAs = (user, role) => {
  const r = user?.roles || [];
  return r.includes(role) || r.includes('Admin') || r.includes('Owner');
};

export function useRBAC() {
  const { user } = useAuth();
  const roles = user?.roles || [];
  const canAccess = (...allowed) => !!user && allowed.some(r => roles.includes(r));
  return { canAccess, roles };
}
