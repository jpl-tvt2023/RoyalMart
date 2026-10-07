import { describe, test, expect } from 'vitest';
import {
  isStitchingLine, RECEIPT_STAGES, outstandingOf, qtyDifference, offeredQtyDiffAction,
  receiptFieldError, stageOptionsFor, defaultReceiptStage,
  emptyLine, toLineState, EMPTY_RECEIPT, NOTE_MAX, receiptIsGraded, receiptGradeTotal,
  receiptSettledDozens, receiptTakesMetres, receiptTakesChecker,
} from '../receiptFields';
import { STAGES, umKind } from '../../../utils/stitching';

const fabric = { qty: 100, received: 0, short: 0, goes_to_stitching: 1, unit_metric: 'taga' };
const packaging = { qty: 100, received: 0, short: 0 };
// A stitching item bought by the piece: made-up goods, which skip Processing.
const pieces = { qty: 1000, received: 0, short: 0, goes_to_stitching: 1, unit_metric: 'pcs' };

// The minimum a receipt needs before the fabric rules are the thing failing.
const valid = {
  received_qty: 10, unit_metric: 'taga', received_rate: 10, bill_no: 'B-1',
  incoming_no: 'IN-1', incoming_stage: 'Processing', qty_in_metres: 400,
};

describe('isStitchingLine', () => {
  test('is the tick off the product master, and nothing else', () => {
    expect(isStitchingLine(fabric)).toBe(true);
    expect(isStitchingLine(pieces)).toBe(true);
    expect(isStitchingLine(packaging)).toBe(false);
    expect(isStitchingLine(null)).toBe(false);
  });
});

describe('RECEIPT_STAGES', () => {
  // 091: goods can be bought straight into Third Party and sold on.
  test('is every stage, Third Party included', () => {
    expect(RECEIPT_STAGES).toEqual(STAGES);
    expect(stageOptionsFor().map(o => o.value)).toEqual(RECEIPT_STAGES);
  });

  // The UM decides: bought in dozens or pieces, the goods are made up and
  // skip Processing. Taga, metres or anything else may still go there.
  test('Processing is offered but disabled for goods bought in dozens or pieces', () => {
    const processing = (kind) => stageOptionsFor(kind).find(o => o.value === 'Processing');
    expect(processing(umKind('taga')).disabled).toBe(false);
    expect(processing(umKind('mtr')).disabled).toBe(false);
    expect(processing(umKind('pcs'))).toMatchObject({
      disabled: true, reason: 'Processing counts metres — goods bought in dozens or pieces cannot be received there',
    });
    expect(processing(umKind('Dzn')).disabled).toBe(true);
    expect(defaultReceiptStage(umKind('taga'))).toBe('Processing');
    expect(defaultReceiptStage(umKind('pcs'))).toBe('Stitching');
  });
});

describe('what a UM settles', () => {
  test('the names are read case- and space-insensitively', () => {
    expect(umKind(' Dzn ')).toBe('dozen');
    expect(umKind('Dz.')).toBe('dozen');
    expect(umKind('Mtr')).toBe('metre');
    expect(umKind('PCS')).toBe('piece');
    expect(umKind('taga')).toBeNull();
    expect(umKind('')).toBeNull();
  });

  test('a dozen UM is the count, and pieces are twelve to the dozen', () => {
    expect(receiptSettledDozens({ received_qty: 30, unit_metric: 'dz', incoming_stage: 'Stitching' }, fabric, 'dozen')).toBe(30);
    expect(receiptSettledDozens({ received_qty: 120, unit_metric: 'pcs', incoming_stage: 'Stitching' }, pieces, 'piece')).toBe(10);
    // Taga settles nothing -- the dozens are counted and typed.
    expect(receiptSettledDozens({ received_qty: 120, unit_metric: 'taga', incoming_stage: 'Stitching' }, fabric, null)).toBeNull();
    // Nothing is counted in dozens at Processing, and packaging has no stage.
    expect(receiptSettledDozens({ received_qty: 30, incoming_stage: 'Processing' }, fabric, 'dozen')).toBeNull();
    expect(receiptSettledDozens({ received_qty: 30, incoming_stage: 'Stitching' }, packaging, 'dozen')).toBeNull();
  });

  test('metres only on a stitching line, and not when bought in dozens or pieces', () => {
    expect(receiptTakesMetres(fabric, null)).toBe(true);
    expect(receiptTakesMetres(fabric, 'metre')).toBe(true);
    expect(receiptTakesMetres(fabric, 'dozen')).toBe(false);
    expect(receiptTakesMetres(pieces, 'piece')).toBe(false);
    expect(receiptTakesMetres(packaging, null)).toBe(false);
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
  // Billed Rate is quoted to 3 decimal places like the agreed rate on its line
  // (socks at 0.156 a piece) -- the server's wording, word for word.
  test('Billed Rate takes 3 decimal places and refuses a 4th', () => {
    expect(receiptFieldError({ ...valid, received_rate: 0.156 }, { line: fabric })).toBeNull();
    expect(receiptFieldError({ ...valid, received_rate: 0.1567 }, { line: fabric }))
      .toBe('Billed Rate can have at most 3 decimal places');
  });

  test('a fabric receipt needs a stage, a number and its metres', () => {
    expect(receiptFieldError({ ...valid, incoming_stage: '' }, { line: fabric }))
      .toMatch(/Stage is required/);
    expect(receiptFieldError({ ...valid, incoming_no: '' }, { line: fabric }))
      .toMatch(/Incoming No is required/);
    expect(receiptFieldError({ ...valid, qty_in_metres: '' }, { line: fabric }))
      .toMatch(/Qty in metres is required/);
    expect(receiptFieldError(valid, { line: fabric })).toBeNull();
  });

  // ...but it does name who checked it in: goods that never reach the
  // Stitching page are checked as they are received or never.
  test('a packaging receipt needs none of them, only a checker', () => {
    const bare = {
      received_qty: 10, unit_metric: 'pcs', received_rate: 10, bill_no: 'B-1', checked_by: '3',
    };
    expect(receiptFieldError(bare, { line: packaging })).toBeNull();
    expect(receiptFieldError({ ...bare, checked_by: '' }, { line: packaging })).toBe('Checked By is required');
    // An older receipt with no checker stored keeps taking unrelated edits.
    expect(receiptFieldError({ ...bare, checked_by: '' }, { line: packaging, requireChecker: false })).toBeNull();
  });

  // The checker's slot is after the fields before it and ahead of the qty
  // difference, as on the server.
  test('a packaging receipt reports Checked By in the server\'s slot', () => {
    const bare = { received_qty: 10, unit_metric: 'pcs', received_rate: 10, bill_no: 'B-1', checked_by: '' };
    expect(receiptFieldError({ ...bare, bill_no: '' }, { line: packaging })).toBe('Bill No is required');
    expect(receiptFieldError({ ...bare, process_rate: '-1' }, { line: packaging })).toMatch(/Process Rate/);
    expect(receiptFieldError({ ...bare, qty_diff_action: 'write_off' }, { line: packaging }))
      .toBe('Checked By is required');
  });

  // Every receipt carries the unit it was counted in, fabric or not. The form
  // fills it from the line and offers no way to change it, so a blank one means
  // a line that has no unit of its own.
  //
  // LAST of the rules, matching where the server puts it: a body missing both
  // this and something earlier must report the earlier one, because the first
  // error is the contract both sides reproduce.
  test('UM is required on every receipt, and reported last', () => {
    expect(receiptFieldError({ ...valid, unit_metric: '' }, { line: fabric }))
      .toMatch(/UM is required/);
    expect(receiptFieldError({ ...valid, unit_metric: '   ', checked_by: '3' }, { line: packaging }))
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

  // The stage heads the form, and the server checks it first too, so it is
  // the first error a body with several omissions reports.
  test('the stage is checked first', () => {
    expect(receiptFieldError({ ...valid, incoming_stage: '', received_qty: '' }, { line: fabric }))
      .toBe('Stage is required');
    const pc = { ...valid, unit_metric: 'pcs', qty_in_metres: '', incoming_stage: 'Processing', received_qty: '' };
    expect(receiptFieldError(pc, { line: pieces }))
      .toBe('Processing counts metres — goods bought in dozens or pieces cannot be received there');
  });

  test('pieces ask neither metres nor a dozen count -- the UM settles it', () => {
    const pc = { ...valid, unit_metric: 'pcs', qty_in_metres: '', received_qty: 120, incoming_stage: 'Stitching' };
    expect(receiptFieldError(pc, { line: pieces })).toBeNull();
    // Graded: the grades must split the settled figure.
    const graded = { ...pc, incoming_stage: 'Packing', fresh_dozens: '8', second_dozens: '0', third_dozens: '0' };
    expect(receiptFieldError(graded, { line: pieces })).toBe('Fresh + Second + Third must add up to 10 dozen');
    expect(receiptFieldError({ ...graded, second_dozens: '2' }, { line: pieces })).toBeNull();
  });

  test('a UM in metres needs no metres typed', () => {
    expect(receiptFieldError({ ...valid, unit_metric: 'mtr', qty_in_metres: '' }, { line: fabric })).toBeNull();
  });

  test('a sale takes no incoming number, and needs our bill and a checker', () => {
    const sale = {
      ...valid, incoming_stage: 'Third Party', incoming_no: '', fresh_dozens: '5',
      second_dozens: '0', third_dozens: '0', outbound_bill_no: '', checked_by: '',
    };
    expect(receiptFieldError({ ...sale, incoming_no: 'IN-1' }, { line: fabric }))
      .toBe('Third Party takes no Incoming No — nothing arrives there');
    expect(receiptFieldError(sale, { line: fabric }))
      .toBe('Outbound Bill No is required when sending to a third party');
    expect(receiptFieldError({ ...sale, outbound_bill_no: 'OB-1' }, { line: fabric }))
      .toBe('Checked By is required');
    expect(receiptFieldError({ ...sale, outbound_bill_no: 'OB-1', checked_by: '3' }, { line: fabric })).toBeNull();
  });

  // Goods received straight into the warehouse are checked in by a Warehouse
  // POC, as a challan into Panchal is. Nowhere else on the chain is it asked.
  test('Panchal needs a checker, and no stage before it does', () => {
    const panchal = {
      ...valid, incoming_stage: 'Panchal', fresh_dozens: '5', second_dozens: '0', third_dozens: '0',
      checked_by: '',
    };
    expect(receiptFieldError(panchal, { line: fabric })).toBe('Checked By is required');
    expect(receiptFieldError({ ...panchal, checked_by: '3' }, { line: fabric })).toBeNull();
    expect(receiptFieldError({ ...valid, incoming_stage: 'Stitching', received_dozens: '5', checked_by: '' },
      { line: fabric })).toBeNull();
  });

  test('receiptTakesChecker: always off the Stitching page, Panchal and Third Party on it', () => {
    for (const stage of STAGES) {
      expect(receiptTakesChecker(fabric, stage)).toBe(stage === 'Panchal' || stage === 'Third Party');
    }
    for (const stage of ['', null, ...STAGES]) {
      expect(receiptTakesChecker(packaging, stage)).toBe(true);
    }
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
    expect(isStitchingLine(serverRow)).toBe(true);
    expect(isStitchingLine(toLineState(serverRow))).toBe(true);
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
    expect(isStitchingLine(line)).toBe(false);
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
