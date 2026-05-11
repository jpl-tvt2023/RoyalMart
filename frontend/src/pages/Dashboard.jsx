import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import AppShell from '../components/layout/AppShell';
import { listPOs } from '../api/marketplacePO.api';
import { listOrderSummary } from '../api/orderSummary.api';
import { ClipboardList, FileText, Truck } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

function StatCard({ to, label, value, icon: Icon, color, sub }) {
  const colors = {
    navy:  'bg-[#003049]/5 border-[#003049]/20 text-[#003049]',
    red:   'bg-red-50 border-red-200 text-red-700',
    amber: 'bg-amber-50 border-amber-200 text-amber-700',
  };
  return (
    <Link
      to={to}
      className={`rounded-xl border p-5 flex items-start gap-4 transition-shadow hover:shadow-sm ${colors[color]}`}
    >
      <div className="p-2.5 rounded-lg bg-white/70 shadow-sm">
        <Icon size={22} />
      </div>
      <div>
        <p className="text-2xl font-bold leading-tight">{value}</p>
        <p className="text-sm font-medium opacity-80">{label}</p>
        {sub && <p className="text-xs opacity-60 mt-0.5">{sub}</p>}
      </div>
    </Link>
  );
}

export default function Dashboard() {
  const { user } = useAuth();
  const [openPOs, setOpenPOs] = useState(null);
  const [openOrders, setOpenOrders] = useState(null);
  const [awaitingDispatch, setAwaitingDispatch] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      listPOs({ status: 'Open', page: 1, page_size: 10 }).then(r => r.total ?? 0).catch(() => 0),
      listOrderSummary({ status: 'Open', page: 1, page_size: 10 }).then(r => r.total ?? 0).catch(() => 0),
      listOrderSummary({ has_tracking: 'no', page: 1, page_size: 10 }).then(r => r.total ?? 0).catch(() => 0),
    ]).then(([po, os, aw]) => {
      setOpenPOs(po);
      setOpenOrders(os);
      setAwaitingDispatch(aw);
    }).finally(() => setLoading(false));
  }, []);

  return (
    <AppShell>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-[#003049]">Dashboard</h1>
        <p className="text-gray-500 text-sm mt-0.5">Welcome back, {user?.name}</p>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="rounded-xl border bg-gray-100 animate-pulse h-28" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <StatCard
            to="/purchase-orders"
            label="Open POs"
            value={openPOs}
            icon={FileText}
            color="navy"
            sub="View purchase orders"
          />
          <StatCard
            to="/order-summary"
            label="Open Orders"
            value={openOrders}
            icon={ClipboardList}
            color="amber"
            sub="View order summary"
          />
          <StatCard
            to="/order-summary"
            label="Awaiting Dispatch"
            value={awaitingDispatch}
            icon={Truck}
            color="red"
            sub="No tracking ID yet"
          />
        </div>
      )}
    </AppShell>
  );
}
