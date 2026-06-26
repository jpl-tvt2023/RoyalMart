import { useState, useRef, useEffect } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { ChevronDown } from 'lucide-react';

/**
 * A single top-bar dropdown menu for a group of nav links.
 * Self-contained: manages its own open state, closes on outside click,
 * Escape, and route change. The trigger highlights when the current
 * route belongs to one of its children.
 */
export default function NavDropdown({ label, icon: Icon, items }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const location = useLocation();

  const isActive = items.some(
    it => location.pathname === it.path || location.pathname.startsWith(it.path + '/')
  );

  // Close on route change.
  useEffect(() => { setOpen(false); }, [location.pathname]);

  // Close on outside click + Escape.
  useEffect(() => {
    if (!open) return;
    const onClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const triggerCls = `flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium whitespace-nowrap transition-colors ${
    isActive || open ? 'bg-white/15 text-white' : 'text-white/70 hover:bg-white/10 hover:text-white'
  }`;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className={triggerCls}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {Icon && <Icon size={16} className="shrink-0" />}
        {label}
        <ChevronDown size={14} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full mt-1.5 w-64 max-w-[calc(100vw-1rem)] rounded-xl bg-white shadow-lg ring-1 ring-black/5 p-1.5 z-30"
        >
          {items.map(it => (
            <NavLink
              key={it.path}
              to={it.path}
              role="menuitem"
              className={({ isActive: active }) =>
                `flex items-start gap-2.5 px-3 py-2 rounded-lg transition-colors ${
                  active ? 'bg-[#003049]/8' : 'hover:bg-gray-50'
                }`
              }
            >
              {({ isActive: active }) => (
                <>
                  {it.icon && (
                    <span className={`mt-0.5 shrink-0 ${active ? 'text-[#c1121f]' : 'text-[#003049]/70'}`}>
                      <it.icon size={16} />
                    </span>
                  )}
                  <span className="min-w-0">
                    <span className={`block text-sm font-medium leading-tight ${active ? 'text-[#c1121f]' : 'text-gray-800'}`}>
                      {it.label}
                    </span>
                    {it.description && (
                      <span className="block text-xs text-gray-500 mt-0.5 leading-snug">{it.description}</span>
                    )}
                  </span>
                </>
              )}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}
