import { useState } from 'react';
import AppShell from '../../components/layout/AppShell';
import { useSessionState } from '../../hooks/useSessionState';
import { STAGES } from '../../utils/stitching';
import StageTab from './StageTab';

const SUBTITLES = {
  Gray: 'Fabric as received, before any processing',
  Processed: 'Fabric back from the processing house',
  Stitched: 'Fabric back from the stitching unit',
  Packed: 'Finished and closed — the end of the chain',
};

export default function StitchingPage() {
  const [storedTab, setTab] = useSessionState('stitching.tab', 'Gray');
  // A session holding a stage name from an earlier layout would otherwise render
  // no body and highlight no tab.
  const tab = STAGES.includes(storedTab) ? storedTab : 'Gray';

  // Open-lot counts, reported up by whichever StageTab is mounted — it owns the
  // filters the counts are scoped by, so it is the only thing that can ask for
  // them correctly. Reset on a tab switch so a stale set never briefly labels
  // the new tab's filters.
  const [openCounts, setOpenCounts] = useState({});

  return (
    <AppShell>
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-[#003049]">Stitching</h1>
        <p className="text-gray-500 text-sm">{SUBTITLES[tab]}</p>
      </div>

      <div className="flex gap-1 mb-4 border-b border-gray-200">
        {STAGES.map(s => (
          <button
            key={s}
            type="button"
            onClick={() => setTab(s)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === s ? 'border-[#c1121f] text-[#c1121f]' : 'border-transparent text-gray-500 hover:text-[#003049]'
            }`}
          >
            {s}
            {/* Hidden at zero: a silent tab is precisely the signal that
                nothing there needs doing. */}
            {openCounts[s] > 0 && <span className="ml-1 text-gray-400">({openCounts[s]})</span>}
          </button>
        ))}
      </div>

      {/* Keyed so switching stages remounts rather than reusing the previous
          stage's loaded rows, filters and page — same trick ProcurementPage uses. */}
      <StageTab key={tab} stage={tab} onOpenCounts={setOpenCounts} />
    </AppShell>
  );
}
