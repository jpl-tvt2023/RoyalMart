import { useState } from 'react';
import AppShell from '../../components/layout/AppShell';
import { useSessionState } from '../../hooks/useSessionState';
import { ALL_TAB, STITCHING_TYPES, FABRIC, READYMADE, stagesForType } from '../../utils/stitching';
import StageTab from './StageTab';

// Named for the work being done at each stage. Metres until Processing is
// done with the fabric, dozens from Stitching on.
const SUBTITLES = {
  Processing: 'Fabric at the processing house — counted in metres',
  Stitching: 'Goods with the stitching unit — counted in dozens from here on',
  Packing: 'Goods being packed — counted in dozens',
  Panchal: 'Stock in our warehouse — the end of the chain',
  'Third Party': 'Goods sold out of the business against an outbound bill',
  [ALL_TAB]: 'Every stage in one list — filter by PO No to follow a single chain',
};

// Readymade arrives already made up, so its first tab says so rather than
// implying the goods became pieces here.
const READYMADE_SUBTITLES = {
  ...SUBTITLES,
  Stitching: 'Readymade goods with the stitching unit — counted in dozens',
};

// What each section holds, beside the switch.
const SECTION_HINTS = {
  [FABRIC]: 'Bought by the taga or metre and processed',
  [READYMADE]: 'Bought already made up — no Processing stage',
};

// stage-counts reports per stage, so All has to add them up itself -- over the
// section's own stages only.
const countFor = (tab, counts, stages) => (
  tab === ALL_TAB
    ? stages.reduce((sum, s) => sum + (Number(counts[s]) || 0), 0)
    : Number(counts[tab]) || 0
);

export default function StitchingPage() {
  // The two sections (migration 091): an article's type on the Outbound Product
  // List decides which one its lots show in. A session holding anything else
  // falls back to Fabric, the section that existed before.
  const [storedType, setType] = useSessionState('stitching.type', FABRIC);
  const type = STITCHING_TYPES.includes(storedType) ? storedType : FABRIC;
  const stages = stagesForType(type);
  const tabs = [...stages, ALL_TAB];

  const [storedTab, setTab] = useSessionState('stitching.tab', stages[0]);
  // A session holding a stage name from an earlier layout (Gray, Processed...)
  // -- or Processing, carried over into Readymade, which has none -- would
  // otherwise render no body and highlight no tab. Validated against this
  // section's tabs, not STAGES, or a session left on All would snap back.
  const tab = tabs.includes(storedTab) ? storedTab : stages[0];

  // Open-lot counts, reported up by whichever StageTab is mounted — it owns the
  // filters the counts are scoped by, so it is the only thing that can ask for
  // them correctly. Reset on a tab switch so a stale set never briefly labels
  // the new tab's filters.
  const [openCounts, setOpenCounts] = useState({});

  const switchType = (t) => {
    if (t === type) return;
    setOpenCounts({});
    setType(t);
  };

  const subtitles = type === READYMADE ? READYMADE_SUBTITLES : SUBTITLES;

  return (
    <AppShell>
      <div className="mb-4 flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-[#003049]">Stitching</h1>
          <p className="text-gray-500 text-sm">{subtitles[tab]}</p>
        </div>
        {/* The section switch. A segmented control rather than more tabs: the
            stage tabs below are the daily work, and this picks which set of
            them is showing. */}
        <div className="flex flex-col items-end gap-1">
          <div className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5" role="tablist" aria-label="Section">
            {STITCHING_TYPES.map(t => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={type === t}
                onClick={() => switchType(t)}
                className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${
                  type === t ? 'bg-[#003049] text-white' : 'text-gray-500 hover:text-[#003049]'
                }`}
              >
                {t}
              </button>
            ))}
          </div>
          <span className="text-[11px] text-gray-400">{SECTION_HINTS[type]}</span>
        </div>
      </div>

      <div className="flex gap-1 mb-4 border-b border-gray-200">
        {tabs.map(s => (
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
                nothing there needs doing. All carries the total, since the
                counts come back per stage and it spans every one of them. */}
            {countFor(s, openCounts, stages) > 0 && (
              <span className="ml-1 text-gray-400">({countFor(s, openCounts, stages)})</span>
            )}
          </button>
        ))}
      </div>

      {/* Keyed on section AND stage so switching either remounts rather than
          reusing the previous rows, filters and page — same trick
          ProcurementPage uses. */}
      <StageTab key={`${type}:${tab}`} type={type} stage={tab} onOpenCounts={setOpenCounts} />
    </AppShell>
  );
}
