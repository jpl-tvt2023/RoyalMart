import { Menu, LogOut } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useNavigate } from 'react-router-dom';

export default function Topbar({ onMenuClick }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <header className="h-14 bg-white border-b border-gray-200 flex items-center justify-between px-4 sticky top-0 z-10">
      <button
        onClick={onMenuClick}
        className="lg:hidden p-2 rounded-lg hover:bg-gray-100 text-gray-600"
      >
        <Menu size={20} />
      </button>

      <div className="flex-1 lg:flex-none" />

      <div className="flex items-center gap-3">
        <div className="hidden sm:block text-right">
          <p className="text-sm font-medium text-gray-800 leading-tight">{user?.name}</p>
          <p className="text-xs text-gray-400">{user?.role}</p>
        </div>
        <button
          onClick={handleLogout}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-gray-600 hover:bg-gray-100 hover:text-red-600 transition-colors"
        >
          <LogOut size={16} />
          <span className="hidden sm:inline">Logout</span>
        </button>
      </div>
    </header>
  );
}
