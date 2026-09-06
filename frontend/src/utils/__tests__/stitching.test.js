import { describe, test, expect } from 'vitest';
import {
  STAGES, STAGE_TABS, ALL_TAB, nextStage, prevStage,
  carriedIncomingNo, soleActivePrefix,
  challanError, revertReasonError, CHALLAN_MAX, REVERT_REASON_MAX, fmtQty,
  writeOffReasonError, WRITE_OFF_REASON_MAX, shortOf, STATUSES, OPEN_STATUSES,
} from '../stitching';

describe('STAGE_TABS', () => {
  test('is the stages in chain order with All appended', () => {
    expect(STAGE_TABS).toEqual([...STAGES, ALL_TAB]);
    expect(STAGE_TABS[STAGE_TABS.length - 1]).toBe(ALL_TAB);
  });

  // The guard that matters: STAGES is the domain chain that nextStage/prevStage
  // walk and the DB CHECK constraints mirror. "All" is a view and must never
  // leak into it.
  test('All is not a stage', () => {
    expect(STAGES).not.toContain(ALL_TAB);
    expect(nextStage(ALL_TAB)).toBeNull();
    expect(prevStage(ALL_TAB)).toBeNull();
  });
});

describe('prevStage', () => {
  test('is the inverse of nextStage, and null at the head of the chain', () => {
    expect(prevStage('Gray')).toBeNull();
    expect(prevStage('nope')).toBeNull();
    for (const stage of STAGES.slice(0, -1)) {
      expect(prevStage(nextStage(stage))).toBe(stage);
    }
  });
});

describe('carriedIncomingNo', () => {
  test('carries only the number, so the next stage supplies its own prefix', () => {
    expect(carriedIncomingNo({ incoming_prefix: 'GRY', incoming_no: '123' })).toBe('123');
  });

  test('trims, and is empty when there is nothing to carry', () => {
    expect(carriedIncomingNo({ incoming_no: '  123  ' })).toBe('123');
    expect(carriedIncomingNo({ incoming_no: null })).toBe('');
    expect(carriedIncomingNo(null)).toBe('');
  });
});

describe('soleActivePrefix', () => {
  const pfx = (id, stage, is_active = true) => ({ id, stage, is_active, prefix: `P${id}` });

  test('pre-picks only when the stage leaves no choice', () => {
    expect(soleActivePrefix([pfx(1, 'Processed')], 'Processed').id).toBe(1);
    // Two candidates means guessing, which the user would have to spot and undo.
    expect(soleActivePrefix([pfx(1, 'Processed'), pfx(2, 'Processed')], 'Processed')).toBeNull();
  });

  test('ignores inactive prefixes and other stages', () => {
    const all = [pfx(1, 'Processed', false), pfx(2, 'Processed'), pfx(3, 'Stitched')];
    expect(soleActivePrefix(all, 'Processed').id).toBe(2);
    expect(soleActivePrefix(all, 'Packed')).toBeNull();
    expect(soleActivePrefix(undefined, 'Processed')).toBeNull();
  });
});

describe('challanError', () => {
  // Free text by explicit decision -- pinned so it is not tightened to
  // digits-only without asking again.
  test('accepts anything printable, including non-numeric challan books', () => {
    expect(challanError('4471')).toBeNull();
    expect(challanError('CH-2026/07')).toBeNull();
  });

  test('blank is not an error -- it only means the lot cannot be sent ahead', () => {
    expect(challanError('')).toBeNull();
    expect(challanError(null)).toBeNull();
    expect(challanError(undefined)).toBeNull();
  });

  test('is capped', () => {
    expect(challanError('x'.repeat(CHALLAN_MAX))).toBeNull();
    expect(challanError('x'.repeat(CHALLAN_MAX + 1))).toMatch(/50 characters or less/);
  });
});

describe('revertReasonError', () => {
  test('requires a reason, since the record is the whole point', () => {
    expect(revertReasonError('')).toMatch(/required/);
    expect(revertReasonError('   ')).toMatch(/required/);
    expect(revertReasonError(undefined)).toMatch(/required/);
    expect(revertReasonError('wrong lot')).toBeNull();
  });

  test('is capped', () => {
    expect(revertReasonError('x'.repeat(REVERT_REASON_MAX))).toBeNull();
    expect(revertReasonError('x'.repeat(REVERT_REASON_MAX + 1))).toMatch(/at most 300/);
  });
});

describe('fmtQty', () => {
  // This page carries fabric sold by the metre and packaging sold by the piece,
  // so the unit comes from the PO line. Hardcoding "m" is what printed "5 m"
  // against corrugated boxes.
  test('attaches whatever unit the line uses', () => {
    expect(fmtQty(5, 'pcs')).toBe('5 pcs');
    expect(fmtQty(62.5, 'metre')).toBe('62.5 metre');
  });

  test('falls back to a bare number rather than inventing a unit', () => {
    expect(fmtQty(5, null)).toBe('5');
    expect(fmtQty(5, '')).toBe('5');
    expect(fmtQty(5, undefined)).toBe('5');
  });

  test('keeps fmtNum behaviour -- rounding, and the placeholder for nothing', () => {
    expect(fmtQty(62.499, 'pcs')).toBe('62.5 pcs');
    // The em-dash placeholder must not pick up a unit.
    expect(fmtQty(null, 'pcs')).toBe('—');
    expect(fmtQty('', 'pcs')).toBe('—');
  });
});

describe('shortOf', () => {
  test('is what was sent minus what came back', () => {
    expect(shortOf(40, 38)).toBe(2);
    expect(shortOf(40, 40)).toBe(0);
  });

  // An origin lot was never sent by anyone, so its short is absent rather than
  // zero -- the column renders blank instead of claiming a clean hop.
  test('is null when there is no dispatch to compare against', () => {
    expect(shortOf(null, 38)).toBeNull();
    expect(shortOf(40, null)).toBeNull();
    expect(shortOf('', '')).toBeNull();
  });

  test('rounds to 2dp rather than trailing float error', () => {
    expect(shortOf(0.3, 0.1)).toBe(0.2);
  });
});

describe('writeOffReasonError', () => {
  test('requires a reason', () => {
    expect(writeOffReasonError('')).toMatch(/reason is required/i);
    expect(writeOffReasonError('   ')).toMatch(/reason is required/i);
  });

  test('caps it, and accepts anything within the cap', () => {
    expect(writeOffReasonError('x'.repeat(WRITE_OFF_REASON_MAX))).toBeNull();
    expect(writeOffReasonError('x'.repeat(WRITE_OFF_REASON_MAX + 1)))
      .toMatch(/at most 300 characters/);
  });
});

describe('statuses', () => {
  // In Transit came with a two-step move and went with it. Pinned so it does not
  // creep back: adding a challan IS sending the lot on, and a shortage is a
  // quantity rather than a state.
  test('there is no In Transit', () => {
    expect(STATUSES).not.toContain('In Transit');
    expect(OPEN_STATUSES).not.toContain('In Transit');
  });

  test('every open status is a real status', () => {
    for (const s of OPEN_STATUSES) expect(STATUSES).toContain(s);
  });
});
