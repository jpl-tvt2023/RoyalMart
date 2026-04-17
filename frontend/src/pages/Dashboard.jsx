import { useEffect, useState } from 'react';
import AppShell from '../components/layout/AppShell';
import { getInventory } from '../api/inventory.api';
import { getPackaging } from '../api/packaging.api';
import { AlertTriangle, CheckCircle, Archive, TrendingUp } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

function StatCard({ label, value, icon: Icon, color, sub }) {
  const colors = {
    red:    'bg-red-50 border-red-200 text-red-700',
    green:  'bg-green-50 border-green-200 text-green-700',
    navy:   'bg-[#003049]/5 border-[#003049]/20 text-[#003049]',
    amber:  'bg-amber-50 border-amber-200 text-amber-700',
  };
  return (
    <div className={`rounded-xl border p-5 flex items-start gap-4 ${colors[color]}`}>
      <div className="p-2.5 rounded-lg bg-white/70 shadow-sm">
        <Icon size={22} />
      </div>
      <div>
        <p className="text-2xl font-bold leading-tight">{value}</p>
        <p className="text-sm font-medium opacity-80">{label}</p>
        {sub && <p className="text-xs opacity-60 mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { user } = useAuth();
  const [inv, setInv] = useState([]);
  const [pkg, setPkg] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      getInventory().then(r => setInv(r.data)),
      getPackaging().catch(() => []).then(r => setPkg(Array.isArray(r) ? r : r?.data || [])),
    ]).finally(() => setLoading(false));
  }, []);

  const totalSKUs = inv.length;
  const criticalSKUs = inv.filter(i => i.is_critical).length;
  const totalOnHand = inv.reduce((s, i) => s + parseInt(i.on_hand_qty || 0), 0);
  const totalInTransit = inv.reduce((s, i) => s + parseInt(i.in_transit_qty || 0), 0);
  const criticalPkg = pkg.filter(p => p.is_critical).length;

  return (
    <AppShell>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-[#003049]">Dashboard</h1>
        <p className="text-gray-500 text-sm mt-0.5">Welcome back, {user?.name}</p>
      </div>

      {loading ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="rounded-xl border bg-gray-100 animate-pulse h-28" />
          ))}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            <StatCard label="Total Product SKUs" value={totalSKUs} icon={Archive} color="navy" />
            <StatCard label="Critical Stock" value={criticalSKUs} icon={AlertTriangle} color="red" sub={criticalSKUs > 0 ? 'Needs restocking' : 'All good'} />
            <StatCard label="Total On-Hand" value={totalOnHand.toLocaleString('en-IN')} icon={CheckCircle} color="green" sub="units" />
            <StatCard label="In Transit" value={totalInTransit.toLocaleString('en-IN')} icon={TrendingUp} color="amber" sub="incoming units" />
          </div>

          {criticalSKUs > 0 && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-4 mb-6">
              <div className="flex items-center gap-2 text-red-700 font-semibold mb-2">
                <AlertTriangle size={18} />
                {criticalSKUs} SKU{criticalSKUs > 1 ? 's' : ''} Below Safety Threshold
              </div>
              <div className="flex flex-wrap gap-2">
                {inv.filter(i => i.is_critical).map(i => (
                  <span key={i.sku_id} className="px-2.5 py-0.5 bg-red-100 border border-red-300 rounded-full text-xs text-red-700 font-medium">
                    {i.sku_code} — Net: {i.net_position}
                  </span>
                ))}
              </div>
            </div>
          )}

          {criticalPkg > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
              <div className="flex items-center gap-2 text-amber-700 font-semibold mb-1">
                <AlertTriangle size={18} />
                {criticalPkg} Packaging Material{criticalPkg > 1 ? 's' : ''} Low on Stock
              </div>
            </div>
          )}
        </>
      )}
    </AppShell>
  );
}
