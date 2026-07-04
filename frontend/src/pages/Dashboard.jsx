import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import AppShell from '../components/layout/AppShell';
import Legend from '../components/ui/Legend';
import { listPOs, getPoStatusCountsByVendor } from '../api/marketplacePO.api';
import { listOrderSummary, getGrnAppointmentsByDate, getOrderSummaryCountsByPoc } from '../api/orderSummary.api';
import { listVendors } from '../api/vendors.api';
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
    navy:    'bg-[#003049]/5 border-[#003049]/20 text-[#003049]',
    darkRed: 'bg-red-100 border-red-300 text-red-800',
    red:     'bg-red-50 border-red-200 text-red-700',
    amber:   'bg-amber-50 border-amber-200 text-amber-700',
    yellow:  'bg-yellow-50 border-yellow-200 text-yellow-800',
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

function GrnAppointmentTable({ title, date, rows, navigate, vendors }) {
  const byVendor = Object.fromEntries((rows || []).map(r => [r.vendor, r]));
  const fullRows = (vendors || []).map(v => byVendor[v] || { vendor: v, total: 0, fulfilled: 0 });
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

function PocSummaryTable({ title, rows, pocParam, navigate }) {
  const list = rows || [];
  const totals = list.reduce(
    (acc, r) => ({ po_count: acc.po_count + Number(r.po_count || 0), unit_qty: acc.unit_qty + Number(r.unit_qty || 0) }),
    { po_count: 0, unit_qty: 0 }
  );
  const goToPoc = (row) => {
    const qs = new URLSearchParams({
      status: 'Open',
      [pocParam]: row.id == null ? 'unassigned' : String(row.id),
    }).toString();
    navigate(`/order-summary?${qs}`);
  };
  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="px-3 py-2 border-b border-gray-100 text-xs font-medium text-[#003049]">
        {title}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-2 py-1.5 text-left font-semibold text-gray-600 w-10">Sr No</th>
              <th className="px-2 py-1.5 text-left font-semibold text-gray-600">Name</th>
              <th className="px-2 py-1.5 text-left font-semibold text-gray-600">Open POs</th>
              <th className="px-2 py-1.5 text-left font-semibold text-gray-600">Quantity</th>
            </tr>
          </thead>
          <tbody>
            {list.length === 0 ? (
              <tr><td colSpan={4} className="px-2 py-3 text-center text-gray-400">No POC employees</td></tr>
            ) : list.map((r, i) => (
              <tr
                key={r.id == null ? 'unassigned' : r.id}
                onClick={() => goToPoc(r)}
                className="border-t border-gray-100 cursor-pointer hover:bg-gray-50"
              >
                <td className="px-2 py-1.5 text-gray-500">{i + 1}</td>
                <td className="px-2 py-1.5">{r.name}</td>
                <td className="px-2 py-1.5 font-semibold text-gray-800">{Number(r.po_count || 0)}</td>
                <td className="px-2 py-1.5 font-semibold text-gray-800">{Number(r.unit_qty || 0)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot className="bg-gray-50">
            <tr className="border-t border-gray-200">
              <td className="px-2 py-1.5 font-semibold text-[#003049]" colSpan={2}>Total</td>
              <td className="px-2 py-1.5 font-bold">{totals.po_count}</td>
              <td className="px-2 py-1.5 font-bold">{totals.unit_qty}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

function PoStatusByVendorTable({ data, vendors, navigate }) {
  const byVendor = Object.fromEntries((data?.rows || []).map(r => [r.vendor, r]));
  const fullRows = (vendors || []).map(v => byVendor[v] || { vendor: v, open: 0, closed: 0, deleted: 0 });
  const totals = fullRows.reduce(
    (acc, r) => ({
      open:    acc.open + Number(r.open || 0),
      closed:  acc.closed + Number(r.closed || 0),
      deleted: acc.deleted + Number(r.deleted || 0),
    }),
    { open: 0, closed: 0, deleted: 0 }
  );
  const goTo = (vendor, status) => {
    navigate(`/purchase-orders?${new URLSearchParams({ vendor, status }).toString()}`);
  };
  const Cell = ({ vendor, status, value, className }) => (
    <td
      onClick={() => goTo(vendor, status)}
      className={`px-2 py-1.5 font-semibold cursor-pointer hover:underline ${className}`}
    >
      {value}
    </td>
  );
  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="px-3 py-2 border-b border-gray-100 text-xs font-medium text-[#003049]">
        PO Status by Vendor
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-2 py-1.5 text-left font-semibold text-gray-600">Vendor</th>
              <th className="px-2 py-1.5 text-left font-semibold text-gray-600">Open</th>
              <th className="px-2 py-1.5 text-left font-semibold text-gray-600">Closed</th>
              <th className="px-2 py-1.5 text-left font-semibold text-gray-600">Deleted</th>
            </tr>
          </thead>
          <tbody>
            {fullRows.map(r => (
              <tr key={r.vendor} className="border-t border-gray-100 hover:bg-gray-50">
                <td className="px-2 py-1.5">{r.vendor}</td>
                <Cell vendor={r.vendor} status="Open"    value={Number(r.open || 0)}    className="text-[#003049]" />
                <Cell vendor={r.vendor} status="Closed"  value={Number(r.closed || 0)}  className="text-green-700" />
                <Cell vendor={r.vendor} status="Deleted" value={Number(r.deleted || 0)} className="text-gray-500" />
              </tr>
            ))}
          </tbody>
          <tfoot className="bg-gray-50">
            <tr className="border-t border-gray-200">
              <td className="px-2 py-1.5 font-semibold text-[#003049]">Total</td>
              <td className="px-2 py-1.5 font-bold text-[#003049]">{totals.open}</td>
              <td className="px-2 py-1.5 font-bold text-green-700">{totals.closed}</td>
              <td className="px-2 py-1.5 font-bold text-gray-500">{totals.deleted}</td>
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
  const canSeeGRN    = canAccess('Admin', 'Owner', 'Employee', 'Office_POC', 'Warehouse_POC');
  const canSeeExpiry = canAccess('Admin', 'Owner', 'Employee', 'Office_POC', 'Warehouse_POC');

  const [state, setState] = useState({});
  const [loading, setLoading] = useState(true);
  const [grnVendors, setGrnVendors] = useState([]);

  useEffect(() => {
    listVendors()
      .then(rows => setGrnVendors(rows.filter(v => v.is_active).map(v => v.name)))
      .catch(() => {});
  }, []);

  const todayStr      = todayISO();
  const yestStr       = previousWorkingDayISO();
  const expiredToStr  = addDaysISO(-1);
  const in7Str        = addDaysISO(7);
  const in15Str       = addDaysISO(15);

  useEffect(() => {
    const calls = [];
    calls.push(listOrderSummary({ status: 'Open', page: 1, page_size: 10 }).then(r => ['openOrders', r.total ?? 0]).catch(() => ['openOrders', 0]));
    calls.push(listOrderSummary({ has_tracking: 'no', page: 1, page_size: 10 }).then(r => ['awaitingDispatch', r.total ?? 0]).catch(() => ['awaitingDispatch', 0]));

    if (canSeeGRN) {
      calls.push(getGrnAppointmentsByDate(todayStr).then(r => ['grnToday', r.rows || []]).catch(() => ['grnToday', []]));
      calls.push(getGrnAppointmentsByDate(yestStr).then(r => ['grnYesterday', r.rows || []]).catch(() => ['grnYesterday', []]));
      calls.push(getOrderSummaryCountsByPoc().then(r => ['pocCounts', r]).catch(() => ['pocCounts', { office: [], warehouse: [] }]));
      calls.push(getPoStatusCountsByVendor().then(r => ['poStatusByVendor', r]).catch(() => ['poStatusByVendor', { rows: [], totals: { open: 0, closed: 0, deleted: 0 } }]));
    }
    if (canSeeExpiry) {
      calls.push(listPOs({ status: 'Open', po_expiry_date_to: expiredToStr, page: 1, page_size: 1 }).then(r => ['expired', r.total ?? 0]).catch(() => ['expired', 0]));
      calls.push(listPOs({ status: 'Open', po_expiry_date_from: todayStr, po_expiry_date_to: in7Str,  page: 1, page_size: 1 }).then(r => ['expiry7',  r.total ?? 0]).catch(() => ['expiry7', 0]));
      calls.push(listPOs({ status: 'Open', po_expiry_date_from: todayStr, po_expiry_date_to: in15Str, page: 1, page_size: 1 }).then(r => ['expiry15', r.total ?? 0]).catch(() => ['expiry15', 0]));
    }
    Promise.all(calls)
      .then(entries => setState(Object.fromEntries(entries)))
      .finally(() => setLoading(false));
  }, [canSeeGRN, canSeeExpiry, todayStr, yestStr, expiredToStr, in7Str, in15Str]);

  return (
    <AppShell>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-[#003049]">Dashboard</h1>
        <p className="text-gray-500 text-sm mt-0.5">Welcome back, {user?.name}</p>
      </div>

      {loading ? (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="rounded-xl border bg-gray-100 animate-pulse h-16" />
          ))}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
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
                  to={`/purchase-orders?status=Open&po_expiry_date_to=${expiredToStr}`}
                  label="Expired"
                  value={state.expired ?? 0}
                  icon={CalendarClock}
                  color="darkRed"
                />
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
              <h2 className="text-sm font-semibold text-[#003049] mb-2">Purchase Orders by Vendor</h2>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                <PoStatusByVendorTable data={state.poStatusByVendor} vendors={grnVendors} navigate={navigate} />
              </div>
            </section>
          )}

          {canSeeGRN && (
            <section className="mt-6">
              <h2 className="text-sm font-semibold text-[#003049] mb-2">GRN Appointment Summary</h2>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                <GrnAppointmentTable title="Today" date={todayStr} rows={state.grnToday ?? []} navigate={navigate} vendors={grnVendors} />
                <GrnAppointmentTable title={yesterdayLabel()} date={yestStr} rows={state.grnYesterday ?? []} navigate={navigate} vendors={grnVendors} />
              </div>
            </section>
          )}

          {canSeeGRN && (
            <section className="mt-6">
              <h2 className="text-sm font-semibold text-[#003049] mb-2">Order Summary Status</h2>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                <PocSummaryTable title="Office POC" rows={state.pocCounts?.office} pocParam="office_poc" navigate={navigate} />
                <PocSummaryTable title="Warehouse POC" rows={state.pocCounts?.warehouse} pocParam="warehouse_poc" navigate={navigate} />
              </div>
            </section>
          )}
        </>
      )}
    </AppShell>
  );
}
