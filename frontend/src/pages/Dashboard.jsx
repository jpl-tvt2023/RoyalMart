import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import AppShell from '../components/layout/AppShell';
import Legend from '../components/ui/Legend';
import { listPOs } from '../api/marketplacePO.api';
import { listOrderSummary, getGrnAppointmentsByDate } from '../api/orderSummary.api';
import { ClipboardList, Truck, CalendarClock } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useRBAC } from '../hooks/useRBAC';

const isoLocal = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};
const todayISO = () => isoLocal(new Date());
const previousWorkingDayISO = () => {
  const d = new Date();
  d.setDate(d.getDate() - (d.getDay() === 1 ? 2 : 1));
  return isoLocal(d);
};
const addDaysISO = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return isoLocal(d);
};
const yesterdayLabel = () => (new Date().getDay() === 1 ? 'Saturday' : 'Yesterday');

const TH_ORDERS   = { warn: 25, alert: 50 };
const TH_AWAITING = { warn: 10, alert: 25 };
const thresholdColor = (n, t) => {
  if (n >= t.alert) return 'red';
  if (n >= t.warn)  return 'yellow';
  return 'navy';
};

// Explains the workload colour coding on the stat cards.
const THRESHOLD_LEGEND = [
  { swatch: 'bg-[#003049]/20', label: 'Normal' },
  { swatch: 'bg-yellow-200',   label: 'Warning — building up' },
  { swatch: 'bg-red-200',      label: 'High — needs attention' },
];

function StatCard({ to, label, value, icon: Icon, color }) {
  const colors = {
    navy:   'bg-[#003049]/5 border-[#003049]/20 text-[#003049]',
    red:    'bg-red-50 border-red-200 text-red-700',
    amber:  'bg-amber-50 border-amber-200 text-amber-700',
    yellow: 'bg-yellow-50 border-yellow-200 text-yellow-800',
  };
  return (
    <Link
      to={to}
      className={`rounded-xl border p-3 flex items-center gap-3 transition-shadow hover:shadow-sm ${colors[color] || colors.navy}`}
    >
      <div className="p-1.5 rounded-lg bg-white/70 shadow-sm shrink-0">
        <Icon size={16} />
      </div>
      <div className="min-w-0">
        <p className="text-lg font-bold leading-none">{value}</p>
        <p className="text-xs font-medium opacity-80 mt-1 truncate">{label}</p>
      </div>
    </Link>
  );
}

const GRN_VENDORS = ['Blinkit', 'Scootsy', 'Zepto'];

function GrnAppointmentTable({ title, date, rows, navigate }) {
  const byVendor = Object.fromEntries((rows || []).map(r => [r.vendor, r]));
  const fullRows = GRN_VENDORS.map(v => byVendor[v] || { vendor: v, total: 0, fulfilled: 0 });
  const totals = fullRows.reduce(
    (acc, r) => ({ total: acc.total + Number(r.total || 0), fulfilled: acc.fulfilled + Number(r.fulfilled || 0) }),
    { total: 0, fulfilled: 0 }
  );
  const goToVendor = (vendor) => {
    const qs = new URLSearchParams({
      vendor,
      appointment_date_from: date,
      appointment_date_to:   date,
      grn_status:            'All',
    }).toString();
    navigate(`/grn?${qs}`);
  };
  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="px-3 py-2 border-b border-gray-100 text-xs font-medium text-[#003049]">
        {title} <span className="text-gray-400 font-normal">· {date}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-2 py-1.5 text-left font-semibold text-gray-600">Platform</th>
              <th className="px-2 py-1.5 text-left font-semibold text-gray-600">Total</th>
              <th className="px-2 py-1.5 text-left font-semibold text-gray-600">Fulfilled</th>
              <th className="px-2 py-1.5 text-left font-semibold text-gray-600">Pending</th>
            </tr>
          </thead>
          <tbody>
            {fullRows.map(r => {
              const total = Number(r.total || 0);
              const fulfilled = Number(r.fulfilled || 0);
              const pending = total - fulfilled;
              return (
                <tr
                  key={r.vendor}
                  onClick={() => goToVendor(r.vendor)}
                  className="border-t border-gray-100 cursor-pointer hover:bg-gray-50"
                >
                  <td className="px-2 py-1.5">{r.vendor}</td>
                  <td className="px-2 py-1.5 font-semibold text-gray-800">{total}</td>
                  <td className="px-2 py-1.5 text-green-700">{fulfilled}</td>
                  <td className="px-2 py-1.5 text-amber-700">{pending}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="bg-gray-50">
            <tr className="border-t border-gray-200">
              <td className="px-2 py-1.5 font-semibold text-[#003049]">Total</td>
              <td className="px-2 py-1.5 font-bold">{totals.total}</td>
              <td className="px-2 py-1.5 font-bold text-green-700">{totals.fulfilled}</td>
              <td className="px-2 py-1.5 font-bold text-amber-700">{totals.total - totals.fulfilled}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { canAccess } = useRBAC();
  const canSeeGRN    = canAccess('Admin', 'Owner', 'Office_POC', 'Warehouse_POC');
  const canSeeExpiry = canAccess('Admin', 'Owner', 'Employee', 'Office_POC', 'Warehouse_POC');

  const [state, setState] = useState({});
  const [loading, setLoading] = useState(true);

  const todayStr = todayISO();
  const yestStr  = previousWorkingDayISO();
  const in7Str   = addDaysISO(7);
  const in15Str  = addDaysISO(15);

  useEffect(() => {
    const calls = [];
    calls.push(listOrderSummary({ status: 'Open', page: 1, page_size: 10 }).then(r => ['openOrders', r.total ?? 0]).catch(() => ['openOrders', 0]));
    calls.push(listOrderSummary({ has_tracking: 'no', page: 1, page_size: 10 }).then(r => ['awaitingDispatch', r.total ?? 0]).catch(() => ['awaitingDispatch', 0]));

    if (canSeeGRN) {
      calls.push(getGrnAppointmentsByDate(todayStr).then(r => ['grnToday', r.rows || []]).catch(() => ['grnToday', []]));
      calls.push(getGrnAppointmentsByDate(yestStr).then(r => ['grnYesterday', r.rows || []]).catch(() => ['grnYesterday', []]));
    }
    if (canSeeExpiry) {
      calls.push(listPOs({ status: 'Open', po_expiry_date_from: todayStr, po_expiry_date_to: in7Str,  page: 1, page_size: 1 }).then(r => ['expiry7',  r.total ?? 0]).catch(() => ['expiry7', 0]));
      calls.push(listPOs({ status: 'Open', po_expiry_date_from: todayStr, po_expiry_date_to: in15Str, page: 1, page_size: 1 }).then(r => ['expiry15', r.total ?? 0]).catch(() => ['expiry15', 0]));
    }
    Promise.all(calls)
      .then(entries => setState(Object.fromEntries(entries)))
      .finally(() => setLoading(false));
  }, [canSeeGRN, canSeeExpiry, todayStr, yestStr, in7Str, in15Str]);

  return (
    <AppShell>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-[#003049]">Dashboard</h1>
        <p className="text-gray-500 text-sm mt-0.5">Welcome back, {user?.name}</p>
      </div>

      {loading ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="rounded-xl border bg-gray-100 animate-pulse h-16" />
          ))}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <StatCard
              to="/order-summary?status=Open"
              label="Open Orders"
              value={state.openOrders ?? 0}
              icon={ClipboardList}
              color={thresholdColor(state.openOrders ?? 0, TH_ORDERS)}
            />
            <StatCard
              to="/order-summary?has_tracking=no"
              label="Awaiting Dispatch"
              value={state.awaitingDispatch ?? 0}
              icon={Truck}
              color={thresholdColor(state.awaitingDispatch ?? 0, TH_AWAITING)}
            />
            {canSeeExpiry && (
              <>
                <StatCard
                  to={`/purchase-orders?status=Open&po_expiry_date_from=${todayStr}&po_expiry_date_to=${in7Str}`}
                  label="Expiring in 7 days"
                  value={state.expiry7 ?? 0}
                  icon={CalendarClock}
                  color="red"
                />
                <StatCard
                  to={`/purchase-orders?status=Open&po_expiry_date_from=${todayStr}&po_expiry_date_to=${in15Str}`}
                  label="Expiring in 15 days"
                  value={state.expiry15 ?? 0}
                  icon={CalendarClock}
                  color="yellow"
                />
              </>
            )}
          </div>

          <Legend items={THRESHOLD_LEGEND} className="mt-3" />

          {canSeeGRN && (
            <section className="mt-6">
              <h2 className="text-sm font-semibold text-[#003049] mb-2">GRN Appointment Summary</h2>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                <GrnAppointmentTable title="Today" date={todayStr} rows={state.grnToday ?? []} navigate={navigate} />
                <GrnAppointmentTable title={yesterdayLabel()} date={yestStr} rows={state.grnYesterday ?? []} navigate={navigate} />
              </div>
            </section>
          )}
        </>
      )}
    </AppShell>
  );
}
