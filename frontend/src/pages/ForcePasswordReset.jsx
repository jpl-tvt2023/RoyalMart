import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { changePassword } from '../api/auth.api';
import { Package2, Eye, EyeOff } from 'lucide-react';
import toast from 'react-hot-toast';

export default function ForcePasswordReset() {
  const { user, refreshUser } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ newPassword: '', confirm: '' });
  const [show, setShow] = useState({ new: false, confirm: false });
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (form.newPassword !== form.confirm) {
      toast.error('Passwords do not match');
      return;
    }
    if (form.newPassword.length < 8) {
      toast.error('Password must be at least 8 characters');
      return;
    }
    setLoading(true);
    try {
      await changePassword({ newPassword: form.newPassword });
      refreshUser({ is_first_login: false });
      toast.success('Password updated! Welcome to Royal Mart ROMS.');
      navigate('/dashboard');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to update password');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#fdf0d5] flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-[#c1121f] rounded-2xl mb-4 shadow-lg">
            <Package2 size={32} className="text-white" />
          </div>
          <h1 className="text-2xl font-bold text-[#003049]">Set Your Password</h1>
          <p className="text-[#003049]/60 mt-1 text-sm">Hello {user?.name} — please set a new password to continue</p>
        </div>

        <div className="bg-white rounded-2xl shadow-xl p-8 border border-[#003049]/10">
          <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-800 mb-6">
            This is your first login. You must set a new password before proceeding.
          </div>
          <form onSubmit={handleSubmit} className="space-y-4">
            {[
              { label: 'New Password', key: 'newPassword', showKey: 'new' },
              { label: 'Confirm Password', key: 'confirm', showKey: 'confirm' },
            ].map(({ label, key, showKey }) => (
              <div key={key}>
                <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
                <div className="relative">
                  <input
                    type={show[showKey] ? 'text' : 'password'}
                    required
                    value={form[key]}
                    onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                    className="w-full px-4 py-2.5 pr-10 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f] text-sm"
                    placeholder="••••••••"
                  />
                  <button type="button" onClick={() => setShow(s => ({ ...s, [showKey]: !s[showKey] }))} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                    {show[showKey] ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>
            ))}
            <button
              type="submit"
              disabled={loading}
              className="w-full bg-[#c1121f] text-white py-2.5 rounded-lg font-semibold hover:bg-[#a01019] transition-colors disabled:opacity-60 flex items-center justify-center gap-2 mt-2"
            >
              {loading && <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />}
              {loading ? 'Saving...' : 'Set Password & Continue'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
