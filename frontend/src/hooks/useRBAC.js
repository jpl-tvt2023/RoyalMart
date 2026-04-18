import { useAuth } from '../context/AuthContext';

export function useRBAC() {
  const { user } = useAuth();
  const roles = user?.roles || [];
  const canAccess = (...allowed) => !!user && allowed.some(r => roles.includes(r));
  return { canAccess, roles };
}
