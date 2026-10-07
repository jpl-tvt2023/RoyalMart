import { describe, test, expect } from 'vitest';
import {
  STAGES, STAGE_TABS, ALL_TAB, nextStage, DESTINATIONS, destinationsFor, canSendTo,
  EXIT_STAGE, STOCK_STAGE, PARTY_USE_STAGES,
  DOZEN_STAGES, countsDozens, balanceUnitFor, stageRateUnit, stageRateSuffix, stageRateLabel, metresPerDozen,
  carriedIncomingNo, soleActivePrefix,
  challanError, revertReasonError, CHALLAN_MAX, REVERT_REASON_MAX, fmtQty,
  writeOffReasonError, WRITE_OFF_REASON_MAX, STATUSES, OPEN_STATUSES, statusesFor,
  GRADED_STAGES, isGradedStage, GRADE_COLUMNS, gradesOf, RATE_STAGES, isRateStage,
  umKind, countsInDozens, derivedDozens, receiptHasMetres, receiptStageBlockReason,
  DOZEN_UMS, METRE_UMS, PIECE_UMS, CHECKER_STAGES, isCheckerStage,
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

  // Material never goes backwards. It may SKIP a stage — Processing straight to
  // Packing is a real route — but it never returns to one it has left.
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

  // Gray is gone: fabric is never booked in raw, so the chain starts at the
  // first stage that works on it. The stages are named for the work done.
  test('the chain is Processing, Stitching, Packing, then the warehouse or the exit', () => {
    expect(STAGES).toEqual(['Processing', 'Stitching', 'Packing', 'Panchal', 'Third Party']);
    expect(STAGES).not.toContain('Gray');
    expect(nextStage('Processing')).toBe('Stitching');
  });

  test('canSendTo rejects a route that is not in the table', () => {
    expect(canSendTo('Processing', 'Packing')).toBe(true);
    expect(canSendTo('Packing', 'Stitching')).toBe(false);
    expect(canSendTo('Stitching', 'Processing')).toBe(false);
  });

  // A tag means "works at this stage" since migration 090 -- a challan names
  // its SENDER, so a processing house is tagged Processing again.
  test('party use tags are every stage', () => {
    expect(PARTY_USE_STAGES).toEqual(STAGES);
    expect(PARTY_USE_STAGES).toContain('Processing');
  });
});

// Twins of GRADED_STAGES / RATE_STAGES in the backend service (migration 089).
describe('grades and stage rates', () => {
  test('goods arrive graded from Packing on, and not at Stitching', () => {
    expect(GRADED_STAGES).toEqual(['Packing', 'Panchal', 'Third Party']);
    expect(isGradedStage('Stitching')).toBe(false);
    expect(isGradedStage('Panchal')).toBe(true);
    expect(GRADE_COLUMNS).toEqual({ Fresh: 'fresh_dozens', Second: 'second_dozens', Third: 'third_dozens' });
  });

  test('gradesOf keeps the grades above 0, in type order', () => {
    expect(gradesOf({ fresh_dozens: 10, second_dozens: 0, third_dozens: 2.5 }))
      .toEqual([['Fresh', 10], ['Third', 2.5]]);
    expect(gradesOf({})).toEqual([]);
  });

  test('only the stages that send keep a rate of their own', () => {
    expect(RATE_STAGES).toEqual(['Processing', 'Stitching', 'Packing']);
    expect(isRateStage('Panchal')).toBe(false);
    expect(isRateStage('Third Party')).toBe(false);
  });
});

// Processing is the last stage in metres. From Stitching on the goods are
// counted in dozens and nothing else, and every challan rate is per dozen.
describe('dozens and yield', () => {
  test('dozens are counted from Stitching on, metres only at Processing', () => {
    expect(DOZEN_STAGES).toEqual(['Stitching', 'Packing', 'Panchal', 'Third Party']);
    for (const stage of DOZEN_STAGES) {
      expect(countsDozens(stage)).toBe(true);
      expect(balanceUnitFor(stage)).toBe('dz');
    }
    expect(countsDozens('Processing')).toBe(false);
    expect(balanceUnitFor('Processing')).toBe('m');
  });

  // A challan's rate belongs to the stage the goods LEAVE, in that stage's unit:
  // the Processing rate is per metre, every rate after it per dozen.
  test('a stage rate is per metre at Processing, per dozen after, and named for the stage', () => {
    expect(stageRateUnit('Processing')).toBe('metre');
    for (const stage of DOZEN_STAGES) expect(stageRateUnit(stage)).toBe('dozen');
    expect(stageRateSuffix('Processing')).toBe('/m');
    expect(stageRateSuffix('Packing')).toBe('/dz');
    expect(stageRateLabel('Processing')).toBe('Processing rate');
    expect(stageRateLabel('Stitching')).toBe('Stitching rate');
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

});

describe('carriedIncomingNo', () => {
  test('carries only the number, so the next stage supplies its own prefix', () => {
    expect(carriedIncomingNo({ incoming_prefix: 'PRC', incoming_no: '123' })).toBe('123');
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
    expect(soleActivePrefix([pfx(1, 'Processing')], 'Processing').id).toBe(1);
    // Two candidates means guessing, which the user would have to spot and undo.
    expect(soleActivePrefix([pfx(1, 'Processing'), pfx(2, 'Processing')], 'Processing')).toBeNull();
  });

  test('ignores inactive prefixes and other stages', () => {
    const all = [pfx(1, 'Processing', false), pfx(2, 'Processing'), pfx(3, 'Stitching')];
    expect(soleActivePrefix(all, 'Processing').id).toBe(2);
    expect(soleActivePrefix(all, 'Packing')).toBeNull();
    expect(soleActivePrefix(undefined, 'Processing')).toBeNull();
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

// Each tab's status filter offers only what a lot there can actually be --
// the same rules computeStatus applies on the server.
describe('statusesFor', () => {
  test('a working stage is Pending, Partial or Forwarded', () => {
    for (const stage of ['Processing', 'Stitching', 'Packing']) {
      expect(statusesFor(stage)).toEqual(['Pending', 'Partial', 'Forwarded']);
    }
  });

  test('the warehouse holds or closes, and a sale is only ever Sold', () => {
    expect(statusesFor(STOCK_STAGE)).toEqual(['In Stock', 'Closed']);
    expect(statusesFor(EXIT_STAGE)).toEqual(['Sold']);
  });

  test('the All view offers every status, and the tabs together cover them', () => {
    expect(statusesFor(ALL_TAB)).toEqual(STATUSES);
    const union = new Set(STAGES.flatMap(statusesFor));
    expect([...union].sort()).toEqual([...STATUSES].sort());
  });
});

// Twin of the server's CHECKER_STAGES, held to the value the backend suite
// asserts ("the mirrored constants"): the two stages a challan or a PO receipt
// into asks Checked By.
describe('CHECKER_STAGES', () => {
  test('is our warehouse and the exit', () => {
    expect(CHECKER_STAGES).toEqual(['Panchal', 'Third Party']);
    expect(CHECKER_STAGES).toEqual([STOCK_STAGE, EXIT_STAGE]);
    expect(isCheckerStage('Panchal')).toBe(true);
    expect(isCheckerStage('Third Party')).toBe(true);
    for (const stage of ['Processing', 'Stitching', 'Packing', '', null]) {
      expect(isCheckerStage(stage)).toBe(false);
    }
  });
});

// The UM decides how goods travel the chain. Twins of the server's helpers,
// held to the same values the backend suite asserts ("the mirrored
// constants"), so the two sides cannot drift apart unnoticed.
describe('what a UM means', () => {
  test('the UM name lists', () => {
    expect(DOZEN_UMS).toEqual(['dozen', 'dozens', 'dzn', 'dz', 'doz']);
    expect(METRE_UMS).toEqual(['metre', 'metres', 'meter', 'meters', 'mtr', 'mtrs', 'm']);
    expect(PIECE_UMS).toEqual(['pcs', 'pc', 'piece', 'pieces']);
  });

  test('dozens and pieces are made-up goods', () => {
    expect(countsInDozens(umKind('Dzn'))).toBe(true);
    expect(countsInDozens(umKind('pcs'))).toBe(true);
    expect(countsInDozens(umKind('mtr'))).toBe(false);
    expect(countsInDozens(umKind('taga'))).toBe(false);
  });

  test('what a UM settles', () => {
    expect(derivedDozens(30, umKind('Dzn'))).toBe(30);
    expect(derivedDozens(100, umKind('pcs'))).toBe(8.33);
    expect(derivedDozens(100, umKind('taga'))).toBeNull();
    expect(receiptHasMetres(umKind('taga'))).toBe(true);
    expect(receiptHasMetres(umKind('dozen'))).toBe(false);
    expect(receiptHasMetres(umKind('pcs'))).toBe(false);
    expect(receiptStageBlockReason('Processing', umKind('pcs')))
      .toBe('Processing counts metres — goods bought in dozens or pieces cannot be received there');
    expect(receiptStageBlockReason('Processing', umKind('mtr'))).toBeNull();
    expect(receiptStageBlockReason('Stitching', umKind('pcs'))).toBeNull();
  });
});
