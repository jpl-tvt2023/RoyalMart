import { useAuth } from '../context/AuthContext';

export const qualifiesAs = (user, role) => {
  const r = user?.roles || [];
  return r.includes(role) || r.includes('Admin') || r.includes('Owner');
};

export function useRBAC() {
  const { user } = useAuth();
  const roles = user?.roles || [];
  const canAccess = (...allowed) => !!user && allowed.some(r => roles.includes(r));
  // Admin/Owner control the Admin section; everyone else (Employee + POC tags) is general staff.
  const isAdmin = roles.includes('Admin') || roles.includes('Owner');
  // Non-admin pages are fully read/write for any authenticated user.
  const canEdit = !!user;
  return { canAccess, roles, isAdmin, canEdit };
}
