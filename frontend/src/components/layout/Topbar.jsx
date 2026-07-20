import { useState, useEffect, useRef } from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { LogOut, Menu, X } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { NAV } from '../../utils/roles';
import NavDropdown from './NavDropdown';

export default function Topbar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const mobilePanelRef = useRef(null);

  const userRoles = user?.roles || [];

  // Build the nav the current user is allowed to see. A leaf needs a matching
  // role; a group keeps only its visible children and is dropped if empty.
  const canSee = (item) => item.roles.some(r => userRoles.includes(r));
  const visibleNav = NAV.map(entry => {
    if (entry.children) {
      const children = entry.children.filter(canSee);
      return children.length ? { ...entry, children } : null;
    }
    return canSee(entry) ? entry : null;
  }).filter(Boolean);

  // Close mobile menu on route change.
  useEffect(() => { setMenuOpen(false); }, [location.pathname]);

  // Close mobile menu on outside click.
  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (e) => {
      if (mobilePanelRef.current && !mobilePanelRef.current.contains(e.target)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [menuOpen]);

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  const linkCls = ({ isActive }) =>
    `flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium whitespace-nowrap transition-colors ${
      isActive
        ? 'bg-white/15 text-white'
        : 'text-white/70 hover:bg-white/10 hover:text-white'
    }`;

  const mobileLinkCls = ({ isActive }) =>
    `flex items-center gap-2 px-4 py-2.5 text-sm font-medium ${
      isActive
        ? 'bg-[#c1121f] text-white'
        : 'text-white/80 hover:bg-white/10 hover:text-white'
    }`;

  return (
    <header className="bg-[#003049] sticky top-0 z-20" ref={mobilePanelRef}>
      <div className="h-14 px-4 flex items-center gap-4">
        {/* Logo + brand */}
        <div className="flex items-center shrink-0">
          <img src="/logo-wordmark.png" alt="Royal Mart" className="h-9 w-auto object-contain rounded" />
        </div>

        {/* Desktop nav */}
        <nav className="hidden lg:flex items-center gap-1 flex-1">
          {visibleNav.map(entry =>
            entry.children ? (
              <NavDropdown key={entry.label} label={entry.label} icon={entry.icon} items={entry.children} />
            ) : (
              <NavLink key={entry.path} to={entry.path} className={linkCls}>
                {entry.icon && <entry.icon size={16} className="shrink-0" />}
                {entry.label}
              </NavLink>
            )
          )}
        </nav>

        {/* Spacer for mobile (push user info to the right) */}
        <div className="flex-1 lg:hidden" />

        {/* User info + Logout */}
        <div className="flex items-center gap-3 shrink-0">
          <div className="hidden sm:block text-right">
            <p className="text-sm font-medium text-white leading-tight">{user?.name}</p>
            <p className="text-xs text-white/50">{userRoles.join(', ') || '—'}</p>
          </div>
          <button
            onClick={handleLogout}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm text-white/80 hover:bg-white/10 hover:text-white transition-colors"
          >
            <LogOut size={16} />
            <span className="hidden sm:inline">Logout</span>
          </button>

          {/* Mobile hamburger */}
          <button
            onClick={() => setMenuOpen(m => !m)}
            className="lg:hidden p-2 rounded-md text-white/80 hover:bg-white/10 hover:text-white"
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
          >
            {menuOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>
      </div>

      {/* Mobile dropdown — grouped into labeled sections */}
      {menuOpen && (
        <nav className="lg:hidden border-t border-white/10 bg-[#003049] pb-2">
          {visibleNav.map(entry =>
            entry.children ? (
              <div key={entry.label} className="pt-1">
                <p className="px-4 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-white/40">
                  {entry.label}
                </p>
                {entry.children.map(child => (
                  <NavLink key={child.path} to={child.path} className={mobileLinkCls}>
                    {child.icon && <child.icon size={16} className="shrink-0" />}
                    {child.label}
                  </NavLink>
                ))}
              </div>
            ) : (
              <NavLink key={entry.path} to={entry.path} className={mobileLinkCls}>
                {entry.icon && <entry.icon size={16} className="shrink-0" />}
                {entry.label}
              </NavLink>
            )
          )}
        </nav>
      )}
    </header>
  );
}
