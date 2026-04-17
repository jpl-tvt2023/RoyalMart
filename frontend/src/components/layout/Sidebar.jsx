import { NavLink } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { NAV_MAP } from '../../utils/roles';
import { Package2, X } from 'lucide-react';

export default function Sidebar({ isOpen, onClose }) {
  const { user } = useAuth();
  const navItems = NAV_MAP.filter(item => item.roles.includes(user?.role));

  return (
    <>
      {isOpen && (
        <div className="fixed inset-0 z-20 bg-black/50 lg:hidden" onClick={onClose} />
      )}

      <aside className={`
        fixed top-0 left-0 h-full w-64 bg-[#003049] flex flex-col z-30
        transform transition-transform duration-300
        ${isOpen ? 'translate-x-0' : '-translate-x-full'}
        lg:relative lg:translate-x-0 lg:flex lg:z-auto
      `}>
        <div className="flex items-center justify-between px-5 py-5 border-b border-white/10">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 bg-[#c1121f] rounded-lg flex items-center justify-center">
              <Package2 size={18} className="text-white" />
            </div>
            <div>
              <p className="text-white font-bold text-sm leading-tight">Royal Mart</p>
              <p className="text-white/50 text-xs">ROMS Portal</p>
            </div>
          </div>
          <button onClick={onClose} className="lg:hidden text-white/60 hover:text-white">
            <X size={18} />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-0.5">
          {navItems.map(item => (
            <NavLink
              key={item.path}
              to={item.path}
              onClick={onClose}
              className={({ isActive }) =>
                `flex items-center px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-[#c1121f] text-white'
                    : 'text-white/70 hover:bg-white/10 hover:text-white'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="px-4 py-4 border-t border-white/10">
          <p className="text-white/40 text-xs">Logged in as</p>
          <p className="text-white text-sm font-medium truncate">{user?.name}</p>
          <p className="text-white/50 text-xs">{user?.role}</p>
        </div>
      </aside>
    </>
  );
}
