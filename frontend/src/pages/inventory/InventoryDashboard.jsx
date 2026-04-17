import { useEffect, useState, useCallback } from 'react';
import AppShell from '../../components/layout/AppShell';
import StatusPill from '../../components/ui/StatusPill';
import AuditDrawer from '../../components/shared/AuditDrawer';
import { getInventory, getInventoryAudit } from '../../api/inventory.api';
import { Clock, Search, AlertTriangle } from 'lucide-react';
import toast from 'react-hot-toast';
import { formatDateTime } from '../../utils/formatters';

export default function InventoryDashboard() {
  const [inventory, setInventory] = useState([]);
  const [filtered, setFiltered] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [auditDrawer, setAuditDrawer] = useState(null);

  const load = () => {
    setLoading(true);
    getInventory().then(r => { setInventory(r.data); setFiltered(r.data); }).catch(() => toast.error('Failed to load inventory')).finally(() => setLoading(false));
  };
  useEffect(load, []);

  useEffect(() => {
    const q = search.toLowerCase();
    let data = inventory;
    if (filter === 'critical') data = data.filter(i => i.is_critical);
    if (q) data = data.filter(i =>
      i.sku_code.toLowerCase().includes(q) ||
      i.name.toLowerCase().includes(q) ||
      (i.color || '').toLowerCase().includes(q)
    );
    setFiltered(data);
  }, [search, filter, inventory]);

  const fetchAudit = useCallback((skuId) => () => getInventoryAudit(skuId), []);

  const criticalCount = inventory.filter(i => i.is_critical).length;

  return (
    <AppShell>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#003049]">Inventory Dashboard</h1>
          <p className="text-gray-500 text-sm">{filtered.length} SKU{filtered.length !== 1 ? 's' : ''} · {criticalCount > 0 ? <span className="text-red-600 font-medium">{criticalCount} critical</span> : 'All OK'}</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-3 mb-4">
        <div className="relative">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search SKUs…" className="pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f] w-52" />
        </div>
        <div className="flex rounded-lg border border-gray-200 overflow-hidden text-sm">
          {['all', 'critical'].map(f => (
            <button key={f} onClick={() => setFilter(f)} className={`px-4 py-2 font-medium transition-colors ${filter === f ? 'bg-[#003049] text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
              {f === 'all' ? 'All SKUs' : '⚠ Critical Only'}
            </button>
          ))}
        </div>
        <button onClick={load} className="px-3 py-2 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50">↻ Refresh</button>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                {['SKU Code', 'Name', 'Color', 'On Hand', 'In Transit', 'Committed', 'Net Position', 'Status', 'Last Updated', 'History'].map(h => (
                  <th key={h} className="px-4 py-3 text-left font-semibold text-gray-600 whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                [...Array(6)].map((_, i) => (
                  <tr key={i}><td colSpan={10} className="px-4 py-3"><div className="h-4 bg-gray-100 rounded animate-pulse" /></td></tr>
                ))
              ) : filtered.map(item => (
                <tr key={item.sku_id} className={`border-b border-gray-100 transition-colors ${item.is_critical ? 'bg-red-50/40 hover:bg-red-50' : 'hover:bg-gray-50'}`}>
                  <td className="px-4 py-3 font-mono text-xs font-semibold text-[#003049]">{item.sku_code}</td>
                  <td className="px-4 py-3 font-medium text-gray-900 max-w-[180px] truncate">{item.name}</td>
                  <td className="px-4 py-3 text-gray-600">{item.color || '—'}</td>
                  <td className="px-4 py-3 font-semibold text-gray-800">{parseInt(item.on_hand_qty).toLocaleString('en-IN')}</td>
                  <td className="px-4 py-3 text-blue-600 font-medium">{parseInt(item.in_transit_qty).toLocaleString('en-IN')}</td>
                  <td className="px-4 py-3 text-amber-600 font-medium">{parseInt(item.committed_qty).toLocaleString('en-IN')}</td>
                  <td className={`px-4 py-3 font-bold ${item.is_critical ? 'text-red-600' : 'text-green-600'}`}>
                    {parseInt(item.net_position).toLocaleString('en-IN')}
                  </td>
                  <td className="px-4 py-3"><StatusPill isCritical={item.is_critical} /></td>
                  <td className="px-4 py-3 text-xs text-gray-400 whitespace-nowrap">{formatDateTime(item.updated_at)}</td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => setAuditDrawer({ skuId: item.sku_id, name: item.sku_code })}
                      title="View history"
                      className="p-1.5 rounded hover:bg-[#003049]/10 text-[#003049]/60 hover:text-[#003049] transition-colors"
                    >
                      <Clock size={15} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && filtered.length === 0 && (
            <div className="text-center py-12 text-gray-400">
              {filter === 'critical' ? <><AlertTriangle className="mx-auto mb-2 text-gray-300" size={32} /><p>No critical items</p></> : <p>No inventory data</p>}
            </div>
          )}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-4 text-xs text-gray-400">
        <span>Net Position = On Hand + In Transit − Committed</span>
        <span>· CRITICAL = Net Position &lt; Safety Threshold</span>
      </div>

      <AuditDrawer
        isOpen={!!auditDrawer}
        onClose={() => setAuditDrawer(null)}
        title={`History — ${auditDrawer?.name}`}
        fetchFn={auditDrawer ? fetchAudit(auditDrawer.skuId) : null}
      />
    </AppShell>
  );
}
