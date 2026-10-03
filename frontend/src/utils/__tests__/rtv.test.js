import { describe, test, expect } from 'vitest';
import { rtvQualifies, rtvRowError, RTV_STATUSES, BLANK_STATUS } from '../rtv';

// Twin of backend/src/services/rtv.service.js and the RTV controller's PATCH
// rules (migration 092). The messages are the server's, verbatim -- the backend
// suite (tests/rtv.test.js) asserts the same strings.
describe('rtvQualifies', () => {
  test('returned to vendor, or short on receipt, and not deleted', () => {
    expect(rtvQualifies({ status: 'Closed', grn_status: 'Returned to Vendor' })).toBe(true);
    expect(rtvQualifies({ status: 'Closed', grn_status: 'Delivered - GRN Received', discrepancy_qty: 2 })).toBe(true);
    expect(rtvQualifies({ status: 'Closed', grn_status: 'Delivered - GRN Received', discrepancy_qty: 0 })).toBe(false);
    expect(rtvQualifies({ status: 'Closed', grn_status: 'Pending', discrepancy_qty: '' })).toBe(false);
    expect(rtvQualifies({ status: 'Deleted', grn_status: 'Returned to Vendor' })).toBe(false);
    expect(rtvQualifies(null)).toBe(false);
  });
});

describe('rtvRowError', () => {
  test('RTV Booked needs a credit note, and a credit note needs its date', () => {
    expect(rtvRowError({ status: 'RTV Booked' })).toBe('Credit Note Number is required when the status is RTV Booked');
    expect(rtvRowError({ status: 'RTV Booked', cn_number: 'CN-1' })).toBe('CN Date is required when a Credit Note Number is entered');
    expect(rtvRowError({ status: 'RTV Booked', cn_number: 'CN-1', cn_date: '2026-09-10' })).toBeNull();
  });

  test('Delivered Yes needs its date', () => {
    expect(rtvRowError({ delivered: 'Yes' })).toBe('Delivery Date is required when Delivered is Yes');
    expect(rtvRowError({ delivered: 'Yes', delivery_date: '2026-09-12' })).toBeNull();
    expect(rtvRowError({ delivered: 'No' })).toBeNull();
  });

  test('references are alphanumeric', () => {
    expect(rtvRowError({ inward_tracking_id: 'has space' })).toBe('Inward Tracking ID must be alphanumeric (dashes allowed)');
    expect(rtvRowError({ cn_number: 'CN/1' })).toBe('Credit Note Number must be alphanumeric (dashes allowed)');
  });

  test('Disposed skips the rules for the columns it clears', () => {
    expect(rtvRowError({ status: 'DN - Disposed', delivered: 'Yes', cn_number: 'CN-1' })).toBeNull();
  });

  test('the status vocabulary', () => {
    expect(RTV_STATUSES).toEqual(['RTV Booked', 'DN - Yes', 'DN - Disposed']);
    expect(BLANK_STATUS).toBe('__blank__');
  });
});
