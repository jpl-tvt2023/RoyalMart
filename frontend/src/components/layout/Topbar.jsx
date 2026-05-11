import { useState, useEffect, useRef } from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { LogOut, Menu, X, Package2 } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { NAV_MAP } from '../../utils/roles';

export default function Topbar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const mobilePanelRef = useRef(null);

  const userRoles = user?.roles || [];
  const navItems = NAV_MAP.filter(item => item.roles.some(r => userRoles.includes(r)));

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
    `px-3 py-1.5 rounded-md text-sm font-medium whitespace-nowrap transition-colors ${
      isActive
        ? 'bg-white/15 text-white'
        : 'text-white/70 hover:bg-white/10 hover:text-white'
    }`;

  const mobileLinkCls = ({ isActive }) =>
    `block px-4 py-2.5 text-sm font-medium ${
      isActive
        ? 'bg-[#c1121f] text-white'
        : 'text-white/80 hover:bg-white/10 hover:text-white'
    }`;

  return (
    <header className="bg-[#003049] sticky top-0 z-20" ref={mobilePanelRef}>
      <div className="h-14 px-4 flex items-center gap-4">
        {/* Logo + brand */}
        <div className="flex items-center gap-2.5 shrink-0">
          <div className="w-8 h-8 bg-[#c1121f] rounded-lg flex items-center justify-center">
            <Package2 size={18} className="text-white" />
          </div>
          <div className="hidden sm:block">
            <p className="text-white font-bold text-sm leading-tight">Royal Mart</p>
            <p className="text-white/50 text-xs">ROMS Portal</p>
          </div>
        </div>

        {/* Desktop nav */}
        <nav className="hidden lg:flex items-center gap-0.5 flex-1 overflow-x-auto">
          {navItems.map(item => (
            <NavLink key={item.path} to={item.path} className={linkCls}>
              {item.label}
            </NavLink>
          ))}
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

      {/* Mobile dropdown */}
      {menuOpen && (
        <nav className="lg:hidden border-t border-white/10 bg-[#003049] pb-2">
          {navItems.map(item => (
            <NavLink key={item.path} to={item.path} className={mobileLinkCls}>
              {item.label}
            </NavLink>
          ))}
        </nav>
      )}
    </header>
  );
}
