import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import AppShell from '../../components/layout/AppShell';
import { useSessionState } from '../../hooks/useSessionState';
import {
  STAGES, ALL_TAB, STOCK_STAGE, warehouseTabKey, warehouseIdOfTab,
} from '../../utils/stitching';
import { listWarehouses } from '../../api/warehouses.api';
import StageTab from './StageTab';

// Named for the work being done at each stage. Metres until Processing is
// done with the fabric, dozens from Stitching on -- and goods bought in dozens
// or pieces start at Stitching, skipping Processing altogether.
const SUBTITLES = {
  Processing: 'Fabric at the processing house — counted in metres',
  Stitching: 'Goods with the stitching unit — counted in dozens from here on',
  Packing: 'Goods being packed — counted in dozens',
  'Third Party': 'Goods sold out of the business against an outbound bill',
  [ALL_TAB]: 'Every stage in one list — filter by PO No to follow a single chain',
};

const warehouseSubtitle = (w) => `Stock in our ${w.name} warehouse — the end of the chain`;

// THE TABS, in chain order. The Warehouse stage is never a tab of its own: it
// is one tab per warehouse (migration 096), each named for its warehouse and
// keyed by id so a rename keeps whatever tab a session was on. A retired
// warehouse keeps its tab while it still holds lots, so stock never goes out of
// sight -- it only stops being offered as somewhere to send new goods.
function tabsFor(warehouses) {
  const shown = (warehouses || []).filter(w => w.is_active || Number(w.in_use) > 0);
  return STAGES.flatMap(stage => (
    stage === STOCK_STAGE
      ? shown.map(w => ({ key: warehouseTabKey(w.id), label: w.name, stage, warehouse: w }))
      : [{ key: stage, label: stage, stage, warehouse: null }]
  )).concat({ key: ALL_TAB, label: ALL_TAB, stage: ALL_TAB, warehouse: null });
}

// stage-counts reports per stage, and per warehouse at the Warehouse stage, so
// a warehouse tab reads its own count and All adds up the stages itself.
const countFor = (tab, counts) => {
  if (tab.key === ALL_TAB) return STAGES.reduce((sum, s) => sum + (Number(counts.stages?.[s]) || 0), 0);
  if (tab.warehouse) return Number(counts.warehouses?.[tab.warehouse.id]) || 0;
  return Number(counts.stages?.[tab.stage]) || 0;
};

export default function StitchingPage() {
  const [storedTab, setTab] = useSessionState('stitching.tab', STAGES[0]);
  // null until the master has loaded: the warehouse tabs come from it.
  const [warehouses, setWarehouses] = useState(null);

  useEffect(() => {
    let live = true;
    listWarehouses()
      .then(rows => { if (live) setWarehouses(rows); })
      .catch(err => {
        toast.error(err.response?.data?.message || 'Could not load warehouses');
        if (live) setWarehouses([]);
      });
    return () => { live = false; };
  }, []);

  const tabs = tabsFor(warehouses);
  // A session holding a tab from an earlier layout (Gray, Processed, Panchal
  // before warehouses were data) would otherwise render no body and highlight
  // no tab. A warehouse tab cannot be judged until the master has loaded, so
  // the body simply waits for it rather than flashing the first tab.
  const waiting = warehouses == null && warehouseIdOfTab(storedTab) != null;
  const current = tabs.find(t => t.key === storedTab) || tabs[0];

  // Open-lot counts, reported up by whichever StageTab is mounted — it owns the
  // filters the counts are scoped by, so it is the only thing that can ask for
  // them correctly. Reset on a tab switch so a stale set never briefly labels
  // the new tab's filters.
  const [openCounts, setOpenCounts] = useState({});

  return (
    <AppShell>
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-[#003049]">Stitching</h1>
        <p className="text-gray-500 text-sm">
          {waiting ? '' : (current.warehouse ? warehouseSubtitle(current.warehouse) : SUBTITLES[current.key])}
        </p>
      </div>

      <div className="flex gap-1 mb-4 border-b border-gray-200 overflow-x-auto">
        {tabs.map(t => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap ${
              !waiting && current.key === t.key ? 'border-[#c1121f] text-[#c1121f]' : 'border-transparent text-gray-500 hover:text-[#003049]'
            }`}
          >
            {t.label}
            {/* Hidden at zero: a silent tab is precisely the signal that
                nothing there needs doing. All carries the total, since the
                counts come back per stage and it spans every one of them. */}
            {countFor(t, openCounts) > 0 && (
              <span className="ml-1 text-gray-400">({countFor(t, openCounts)})</span>
            )}
          </button>
        ))}
      </div>

      {/* Keyed so switching tabs remounts rather than reusing the previous
          tab's loaded rows, filters and page — same trick ProcurementPage uses. */}
      {!waiting && (
        <StageTab
          key={current.key}
          tabKey={current.key}
          stage={current.stage}
          warehouse={current.warehouse}
          onOpenCounts={setOpenCounts}
        />
      )}
    </AppShell>
  );
}
