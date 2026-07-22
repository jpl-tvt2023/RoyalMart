import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Eye, EyeOff } from 'lucide-react';
import toast from 'react-hot-toast';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ username: '', password: '' });
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const user = await login(form.username.trim().toLowerCase(), form.password);
      if (user.is_first_login) {
        navigate('/force-reset');
      } else {
        navigate('/dashboard');
      }
    } catch (err) {
      toast.error(err.response?.data?.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#fdf0d5] flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <img src="/logo-wordmark.png" alt="Royal Mart" className="h-16 w-auto object-contain mx-auto mb-4 rounded-lg shadow-lg" />
          <p className="text-[#003049]/60 mt-1">Resource & Order Management System</p>
        </div>

        <div className="bg-white rounded-2xl shadow-xl p-8 border border-[#003049]/10">
          <h2 className="text-xl font-semibold text-[#003049] mb-6">Sign In</h2>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="login-username" className="block text-sm font-medium text-gray-700 mb-1">User ID</label>
              <input
                id="login-username"
                type="text"
                autoCapitalize="none"
                autoCorrect="off"
                required
                value={form.username}
                onChange={e => setForm(f => ({ ...f, username: e.target.value.toLowerCase() }))}
                className="w-full px-4 py-2.5 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f] text-sm"
                placeholder="your user ID"
              />
            </div>
            <div>
              <label htmlFor="login-password" className="block text-sm font-medium text-gray-700 mb-1">Password</label>
              <div className="relative">
                <input
                  id="login-password"
                  type={showPass ? 'text' : 'password'}
                  required
                  value={form.password}
                  onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                  className="w-full px-4 py-2.5 pr-10 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f] text-sm"
                  placeholder="••••••••"
                />
                <button
                  type="button"
                  onClick={() => setShowPass(s => !s)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                >
                  {showPass ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>
            <button
              type="submit"
              disabled={loading}
              className="w-full bg-[#c1121f] text-white py-2.5 rounded-lg font-semibold hover:bg-[#a01019] transition-colors disabled:opacity-60 flex items-center justify-center gap-2 mt-2"
            >
              {loading && <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />}
              {loading ? 'Signing in...' : 'Sign In'}
            </button>
          </form>
        </div>

        <p className="text-center text-xs text-[#003049]/40 mt-6">Royal Mart ROMS v1.0 — Internal Use Only</p>
      </div>
    </div>
  );
}
