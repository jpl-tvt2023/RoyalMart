import { describe, test, expect } from 'vitest';
import {
  STAGES, STAGE_TABS, ALL_TAB, nextStage, DESTINATIONS, destinationsFor, canSendTo,
  EXIT_STAGE, STOCK_STAGE, PARTY_USE_STAGES, rateLadderStages,
  DOZEN_STAGES, countsDozens, metresPerDozen, rateUnitFor,
  carriedIncomingNo, soleActivePrefix,
  challanError, revertReasonError, CHALLAN_MAX, REVERT_REASON_MAX, fmtQty,
  writeOffReasonError, WRITE_OFF_REASON_MAX, STATUSES, OPEN_STATUSES,
} from '../stitching';

describe('STAGE_TABS', () => {
  test('is the stages in chain order with All appended', () => {
    expect(STAGE_TABS).toEqual([...STAGES, ALL_TAB]);
    expect(STAGE_TABS[STAGE_TABS.length - 1]).toBe(ALL_TAB);
  });

  // The guard that matters: STAGES is the domain chain the DB CHECK constraints
  // mirror. "All" is a view and must never leak into it.
  test('All is not a stage', () => {
    expect(STAGES).not.toContain(ALL_TAB);
    expect(nextStage(ALL_TAB)).toBeNull();
    expect(destinationsFor(ALL_TAB)).toEqual([]);
  });
});

// The chain branches now, so "where can this go" is a lookup rather than a step.
// This is the client half of the same guard the server's destination-graph test
// makes: keep the two tables in step.
describe('DESTINATIONS', () => {
  test('every stage has an entry, and every destination is a real stage', () => {
    for (const stage of STAGES) {
      expect(DESTINATIONS).toHaveProperty(stage);
      for (const dest of DESTINATIONS[stage]) expect(STAGES).toContain(dest);
    }
  });

  // Material never goes backwards. It may SKIP a stage — Processed straight to
  // Packed is a real route — but it never returns to one it has left.
  test('material only ever moves forward along the chain', () => {
    for (const stage of STAGES) {
      for (const dest of DESTINATIONS[stage]) {
        expect(STAGES.indexOf(dest)).toBeGreaterThan(STAGES.indexOf(stage));
      }
    }
  });

  test('the two terminal stages lead nowhere', () => {
    expect(destinationsFor(STOCK_STAGE)).toEqual([]);
    expect(destinationsFor(EXIT_STAGE)).toEqual([]);
  });

  test('Gray has exactly one destination, so the chooser can pre-select it', () => {
    expect(destinationsFor('Gray')).toEqual(['Processed']);
    expect(nextStage('Gray')).toBe('Processed');
  });

  test('canSendTo rejects a route that is not in the table', () => {
    expect(canSendTo('Processed', 'Packed')).toBe(true);
    expect(canSendTo('Gray', 'Packed')).toBe(false);
    expect(canSendTo('Packed', 'Stitched')).toBe(false);
  });

  // Gray falls out on its own: nothing is ever SENT to Gray, because material
  // enters the chain there on a receipt.
  test('party use tags are exactly the destinations', () => {
    expect(PARTY_USE_STAGES).not.toContain('Gray');
    expect(PARTY_USE_STAGES).toEqual([...new Set(Object.values(DESTINATIONS).flat())]);
  });
});

// Metres stay the currency of the chain. Dozens are an extra count that only
// exists once there are pieces to count, and the yield is what the count is for.
describe('dozens and yield', () => {
  test('only Stitched and Packed count pieces', () => {
    expect(DOZEN_STAGES).toEqual(['Stitched', 'Packed']);
    expect(countsDozens('Stitched')).toBe(true);
    expect(countsDozens('Packed')).toBe(true);
    for (const stage of ['Gray', 'Processed', 'Panchal', 'Third Party']) {
      expect(countsDozens(stage)).toBe(false);
    }
  });

  test('the yield is metres over dozens, to two places', () => {
    expect(metresPerDozen(96, 40)).toBe(2.4);
    expect(metresPerDozen(100, 3)).toBe(33.33);
  });

  // Number(null) and Number('') are both 0, which is finite — so these have to
  // be rejected before the cast or an empty field reads as a yield of 0 while
  // the user is still typing.
  test('a missing or zero half is blank, never 0 and never Infinity', () => {
    expect(metresPerDozen(96, 0)).toBeNull();
    expect(metresPerDozen(null, 40)).toBeNull();
    expect(metresPerDozen('', 40)).toBeNull();
    expect(metresPerDozen(96, null)).toBeNull();
    expect(metresPerDozen(96, '')).toBeNull();
  });

  // A stitcher is paid by the dozen, a dyer by the metre. The label has to say
  // which, because the same field means different money at different stages.
  test('the rate is per dozen exactly where pieces are counted', () => {
    expect(rateUnitFor('Stitched')).toBe('dozen');
    expect(rateUnitFor('Packed')).toBe('dozen');
    expect(rateUnitFor('Processed')).toBe('metre');
    expect(rateUnitFor('Panchal')).toBe('metre');
  });
});

describe('rateLadderStages', () => {
  // A lot can only have been charged for stages it has actually reached.
  test('covers the stages travelled so far and no further', () => {
    expect(rateLadderStages('Gray')).toEqual(['Gray']);
    expect(rateLadderStages('Stitched')).toEqual(['Gray', 'Processed', 'Stitched']);
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

  // Sold is terminal: the goods are not ours, so there is nothing outstanding
  // about them and they must never be counted as open work.
  test('Sold is a status but is not open work', () => {
    expect(STATUSES).toContain('Sold');
    expect(OPEN_STATUSES).not.toContain('Sold');
  });
});
