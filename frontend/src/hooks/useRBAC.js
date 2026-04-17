import { useAuth } from '../context/AuthContext';

export function useRBAC() {
  const { user } = useAuth();
  const canAccess = (...roles) => !!user && roles.includes(user.role);
  return { canAccess, role: user?.role };
}
