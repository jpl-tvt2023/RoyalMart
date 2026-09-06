import { describe, test, expect } from 'vitest';
import {
  isFabricLine, RECEIPT_STAGES, outstandingOf, qtyDifference, offeredQtyDiffAction,
  receiptFieldError, stageOptionsFor,
} from '../receiptFields';
import { STAGES } from '../../../utils/stitching';

const fabric = { qty: 100, received: 0, short: 0, goes_to_stitching: 1 };
const packaging = { qty: 100, received: 0, short: 0 };

// The minimum a receipt needs before the fabric rules are the thing failing.
const valid = {
  received_qty: 10, received_rate: 10, checked_by: 1, bill_no: 'B-1',
  incoming_no: 'IN-1', incoming_stage: 'Gray', qty_in_metres: 400,
};

describe('isFabricLine', () => {
  test('is the flag off the product master, and nothing else', () => {
    expect(isFabricLine(fabric)).toBe(true);
    expect(isFabricLine(packaging)).toBe(false);
    expect(isFabricLine(null)).toBe(false);
  });
});

describe('RECEIPT_STAGES', () => {
  // Third Party is where material LEAVES us. Nothing is ever bought into it.
  test('is every stage except Third Party', () => {
    expect(RECEIPT_STAGES).not.toContain('Third Party');
    for (const s of STAGES) {
      if (s !== 'Third Party') expect(RECEIPT_STAGES).toContain(s);
    }
    expect(stageOptionsFor().map(o => o.value)).toEqual(RECEIPT_STAGES);
  });
});

describe('outstandingOf', () => {
  test('is the order less what arrived and what was written off', () => {
    expect(outstandingOf({ qty: 100, received: 40, short: 0 })).toBe(60);
    expect(outstandingOf({ qty: 100, received: 40, short: 10 })).toBe(50);
  });

  test('never goes negative on an over delivery', () => {
    expect(outstandingOf({ qty: 100, received: 120, short: 0 })).toBe(0);
  });
});

describe('qtyDifference', () => {
  // Against what is STILL DUE, so a part delivery is not a shortfall.
  test('measures against what is still outstanding', () => {
    const line = { qty: 100, received: 40, short: 0 };
    expect(qtyDifference(60, line)).toBe(0);
    expect(qtyDifference(55, line)).toBe(-5);
    expect(qtyDifference(70, line)).toBe(10);
  });

  test('is absent until a quantity is typed', () => {
    expect(qtyDifference('', fabric)).toBeNull();
    expect(qtyDifference(null, fabric)).toBeNull();
    expect(qtyDifference('abc', fabric)).toBeNull();
  });

  test('rounds to 2dp rather than trailing float error', () => {
    expect(qtyDifference(0.3, { qty: 0.1, received: 0, short: 0 })).toBe(0.2);
  });
});

describe('offeredQtyDiffAction', () => {
  // Exactly one box is ever available, and a matching delivery offers neither.
  test('offers write-off when short and rollover when over', () => {
    expect(offeredQtyDiffAction(-5)).toBe('write_off');
    expect(offeredQtyDiffAction(5)).toBe('rollover');
  });

  test('offers nothing when the delivery matches', () => {
    expect(offeredQtyDiffAction(0)).toBeNull();
    expect(offeredQtyDiffAction(null)).toBeNull();
    // Within epsilon is a match, not a difference.
    expect(offeredQtyDiffAction(0.001)).toBeNull();
  });
});

describe('receiptFieldError', () => {
  test('a fabric receipt needs a stage, a number and its metres', () => {
    expect(receiptFieldError({ ...valid, incoming_stage: '' }, { line: fabric }))
      .toMatch(/Stage is required/);
    expect(receiptFieldError({ ...valid, incoming_no: '' }, { line: fabric }))
      .toMatch(/Incoming No is required/);
    expect(receiptFieldError({ ...valid, qty_in_metres: '' }, { line: fabric }))
      .toMatch(/Qty in metres is required/);
    expect(receiptFieldError(valid, { line: fabric })).toBeNull();
  });

  test('a packaging receipt needs none of them', () => {
    const bare = {
      received_qty: 10, received_rate: 10, checked_by: 1, bill_no: 'B-1',
    };
    expect(receiptFieldError(bare, { line: packaging })).toBeNull();
  });

  test('a ticked box demands a reason', () => {
    expect(receiptFieldError({ ...valid, qty_diff_action: 'write_off' }, { line: fabric }))
      .toMatch(/reason is required to write off/i);
    expect(receiptFieldError({ ...valid, qty_diff_action: 'rollover' }, { line: fabric }))
      .toMatch(/reason is required to roll over/i);
    expect(receiptFieldError(
      { ...valid, qty_diff_action: 'write_off', qty_diff_reason: 'mill short' },
      { line: fabric },
    )).toBeNull();
  });

  test('the reason is capped', () => {
    expect(receiptFieldError(
      { ...valid, qty_diff_action: 'write_off', qty_diff_reason: 'x'.repeat(301) },
      { line: fabric },
    )).toMatch(/at most 300 characters/);
  });
});
