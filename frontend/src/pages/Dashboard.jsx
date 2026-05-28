import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import AppShell from '../components/layout/AppShell';
import { listPOs } from '../api/marketplacePO.api';
import { listOrderSummary, getGrnAppointmentsByDate } from '../api/orderSummary.api';
import { ClipboardList, FileText, Truck, CalendarClock } from 'lucide-react';
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

function GrnAppointmentTable({ title, date, rows }) {
  const totals = rows.reduce(
    (acc, r) => ({ total: acc.total + Number(r.total || 0), fulfilled: acc.fulfilled + Number(r.fulfilled || 0) }),
    { total: 0, fulfilled: 0 }
  );
  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 text-sm font-medium text-[#003049]">
        {title} <span className="text-gray-400 font-normal">· {date}</span>
      </div>
      <table className="w-full text-sm">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-3 py-2 text-left font-semibold text-gray-600">Platform</th>
            <th className="px-3 py-2 text-left font-semibold text-gray-600">Total</th>
            <th className="px-3 py-2 text-left font-semibold text-gray-600">Fulfilled</th>
            <th className="px-3 py-2 text-left font-semibold text-gray-600">Pending</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={4} className="px-3 py-4 text-center text-gray-400">No appointments</td></tr>
          ) : rows.map(r => {
            const total = Number(r.total || 0);
            const fulfilled = Number(r.fulfilled || 0);
            const pending = total - fulfilled;
            return (
              <tr key={r.vendor} className="border-t border-gray-100">
                <td className="px-3 py-2">{r.vendor}</td>
                <td className="px-3 py-2 font-semibold text-gray-800">{total}</td>
                <td className="px-3 py-2 text-green-700">{fulfilled}</td>
                <td className="px-3 py-2 text-amber-700">{pending}</td>
              </tr>
            );
          })}
        </tbody>
        {rows.length > 0 && (
          <tfoot className="bg-gray-50">
            <tr className="border-t border-gray-200">
              <td className="px-3 py-2 font-semibold text-[#003049]">Total</td>
              <td className="px-3 py-2 font-bold">{totals.total}</td>
              <td className="px-3 py-2 font-bold text-green-700">{totals.fulfilled}</td>
              <td className="px-3 py-2 font-bold text-amber-700">{totals.total - totals.fulfilled}</td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

export default function Dashboard() {
  const { user } = useAuth();
  const { canAccess } = useRBAC();
  const canSeeGRN    = canAccess('Admin', 'Owner', 'Office_POC', 'Warehouse_POC');
  const canSeeExpiry = canAccess('Admin', 'Owner', 'Purchase_Team', 'PO_Executive');

  const [state, setState] = useState({});
  const [loading, setLoading] = useState(true);

  const todayStr = todayISO();
  const yestStr  = previousWorkingDayISO();
  const in7Str   = addDaysISO(7);
  const in15Str  = addDaysISO(15);

  useEffect(() => {
    const calls = [];
    calls.push(listPOs({ status: 'Open', page: 1, page_size: 10 }).then(r => ['openPOs', r.total ?? 0]).catch(() => ['openPOs', 0]));
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
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="rounded-xl border bg-gray-100 animate-pulse h-28" />
          ))}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <StatCard
              to="/purchase-orders"
              label="Open POs"
              value={state.openPOs ?? 0}
              icon={FileText}
              color="navy"
              sub="View purchase orders"
            />
            <StatCard
              to="/order-summary"
              label="Open Orders"
              value={state.openOrders ?? 0}
              icon={ClipboardList}
              color="amber"
              sub="View order summary"
            />
            <StatCard
              to="/order-summary"
              label="Awaiting Dispatch"
              value={state.awaitingDispatch ?? 0}
              icon={Truck}
              color="red"
              sub="No tracking ID yet"
            />
          </div>

          {canSeeExpiry && (
            <section className="mt-6">
              <h2 className="text-base font-semibold text-[#003049] mb-3">PO Expiry</h2>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <StatCard
                  to="/purchase-orders"
                  label="Expiring in 7 days"
                  value={state.expiry7 ?? 0}
                  icon={CalendarClock}
                  color="amber"
                  sub="Open POs only"
                />
                <StatCard
                  to="/purchase-orders"
                  label="Expiring in 15 days"
                  value={state.expiry15 ?? 0}
                  icon={CalendarClock}
                  color="red"
                  sub="Open POs only"
                />
              </div>
            </section>
          )}

          {canSeeGRN && (
            <section className="mt-6">
              <h2 className="text-base font-semibold text-[#003049] mb-3">GRN Appointment Summary</h2>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <GrnAppointmentTable title="Today" date={todayStr} rows={state.grnToday ?? []} />
                <GrnAppointmentTable title={yesterdayLabel()} date={yestStr} rows={state.grnYesterday ?? []} />
              </div>
            </section>
          )}
        </>
      )}
    </AppShell>
  );
}
