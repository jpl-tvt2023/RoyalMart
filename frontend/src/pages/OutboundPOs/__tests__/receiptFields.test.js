import { describe, test, expect } from 'vitest';
import {
  isFabricLine, RECEIPT_STAGES, outstandingOf, qtyDifference, offeredQtyDiffAction,
  receiptFieldError, stageOptionsFor,
  emptyLine, toLineState, EMPTY_RECEIPT, NOTE_MAX, receiptIsGraded, receiptGradeTotal,
} from '../receiptFields';
import { STAGES } from '../../../utils/stitching';

const fabric = { qty: 100, received: 0, short: 0, goes_to_stitching: 1 };
const packaging = { qty: 100, received: 0, short: 0 };

// The minimum a receipt needs before the fabric rules are the thing failing.
const valid = {
  received_qty: 10, unit_metric: 'taga', received_rate: 10, bill_no: 'B-1',
  incoming_no: 'IN-1', incoming_stage: 'Processing', qty_in_metres: 400,
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
      received_qty: 10, unit_metric: 'pcs', received_rate: 10, bill_no: 'B-1',
    };
    expect(receiptFieldError(bare, { line: packaging })).toBeNull();
  });

  // Every receipt carries the unit it was counted in, fabric or not -- the form
  // pre-fills it from the line, so a blank one means the user cleared it.
  //
  // LAST of the rules, matching where the server puts it: a body missing both
  // this and something earlier must report the earlier one, because the first
  // error is the contract both sides reproduce.
  test('UM is required on every receipt, and reported last', () => {
    expect(receiptFieldError({ ...valid, unit_metric: '' }, { line: fabric }))
      .toMatch(/UM is required/);
    expect(receiptFieldError({ ...valid, unit_metric: '   ' }, { line: packaging }))
      .toMatch(/UM is required/);
    // Qty in metres is checked before it, so that is what comes back.
    expect(receiptFieldError({ ...valid, unit_metric: '', qty_in_metres: '' }, { line: fabric }))
      .toMatch(/Qty in metres is required/);
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

  // Migration 089: fabric bought in at Packing or Panchal is typed per grade,
  // and Dozens Received is their sum -- so the total is not asked for there.
  test('Packing and Panchal take grades instead of a dozen total', () => {
    const packed = { ...valid, incoming_stage: 'Packing', fresh_dozens: '0', second_dozens: '0', third_dozens: '0' };
    expect(receiptFieldError(packed, { line: fabric })).toBe('Enter the dozens for at least one grade');
    expect(receiptFieldError({ ...packed, second_dozens: '-1' }, { line: fabric }))
      .toBe('Second dozens must be a number >= 0');
    expect(receiptFieldError({ ...packed, fresh_dozens: '12', third_dozens: '3' }, { line: fabric })).toBeNull();
    expect(receiptGradeTotal({ fresh_dozens: '12', second_dozens: '', third_dozens: '3.5' })).toBe(15.5);
    // Stitching counts dozens but is not graded.
    expect(receiptIsGraded(fabric, 'Stitching')).toBe(false);
    expect(receiptIsGraded(fabric, 'Panchal')).toBe(true);
    expect(receiptIsGraded(packaging, 'Panchal')).toBe(false);
  });

  // Free text, last of all, in the slot the server gives it.
  test('the note is optional and capped', () => {
    expect(EMPTY_RECEIPT.note).toBe('');
    expect(receiptFieldError({ ...valid, note: 'Two bales wet' }, { line: fabric })).toBeNull();
    expect(receiptFieldError({ ...valid, note: 'x'.repeat(NOTE_MAX + 1) }, { line: fabric }))
      .toBe('Note must be 1000 characters or less');
  });
});


// The PO detail page does not hand ReceiptModal the API row — it hands it a
// projection, and the projection is an allowlist. Anything the modal reads has
// to survive it.
//
// This exists because goes_to_stitching once did not. The API sent it, the page
// dropped it, and isFabricLine read the missing field as "not fabric" — so the
// Stage, Qty in metres and Dozens fields silently vanished on every fabric line
// while the server went on rejecting the save with "Stage is required". Nothing
// threw, and nothing in the UI said why.
describe('toLineState — the page/modal line contract', () => {
  // Shaped like a row from GET /outbound-pos/:id.
  const serverRow = {
    id: 52, po_id: 19, line_no: 1,
    category: 'Raw Material', item_name: 'Handkerchief - Bundle Fabric', variant: null,
    qty: 250, rate: 25, short: 0, received: 50, unit_metric: 'taga',
    goes_to_stitching: 1,
    flags: [], receipts: [],
    updated_by_name: 'admin', updated_at: '2026-09-13 10:00:00',
    deleted_at: null, deleted_by: null,
  };

  // THE regression. One assertion, and it is the whole bug.
  test('a fabric line is still fabric after the projection', () => {
    expect(isFabricLine(serverRow)).toBe(true);
    expect(isFabricLine(toLineState(serverRow))).toBe(true);
  });

  test('every field ReceiptModal reads survives', () => {
    const line = toLineState(serverRow);
    for (const key of ['category', 'item_name', 'variant', 'qty', 'rate',
      'received', 'short', 'unit_metric', 'goes_to_stitching', 'id']) {
      expect(line).toHaveProperty(key);
    }
    expect(line.goes_to_stitching).toBe(1);
    expect(line.unit_metric).toBe('taga');
  });

  test('a non-fabric line reads as non-fabric rather than as missing', () => {
    const line = toLineState({ ...serverRow, goes_to_stitching: 0 });
    expect(line.goes_to_stitching).toBe(0);
    expect(isFabricLine(line)).toBe(false);
  });

  // A row written before the flag existed must read as non-fabric, not NaN.
  test('an absent flag defaults rather than propagating undefined', () => {
    const { goes_to_stitching, ...withoutFlag } = serverRow;
    expect(goes_to_stitching).toBe(1);
    expect(toLineState(withoutFlag).goes_to_stitching).toBe(0);
  });

  // The two shapes feed the same grid and the same modal, so a field added to
  // one and not the other is the next instance of this bug.
  test('emptyLine and toLineState agree on their fields', () => {
    expect(Object.keys(toLineState(serverRow)).sort())
      .toEqual(Object.keys(emptyLine()).sort());
  });
});
