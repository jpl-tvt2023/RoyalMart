import { describe, test, expect } from 'vitest';
import { entryFieldsError, emptyEntry, FIELDS, TEXT_MAX, BILL_NO_RE } from '../balajiBuilty';

// Twin of backend/src/services/balajiBuilty.service.js (migration 108). The
// messages are the server's, verbatim -- tests/balajiBuilty.test.js asserts
// the same strings, case for case.
describe('entryFieldsError', () => {
  test.each([
    [{}, 'Vendor is required'],
    [{ vendor: '   ' }, 'Vendor is required'],
    [{ vendor: 'V', po_date: '26-11-2026' }, 'Order Date is not a valid date'],
    [{ vendor: 'V', qty: '1.5' }, 'Quantity must be a whole number, 0 or more'],
    [{ vendor: 'V', qty: '-3' }, 'Quantity must be a whole number, 0 or more'],
    [{ vendor: 'V', city: 'x'.repeat(201) }, 'City must be at most 200 characters'],
    [{ vendor: 'V', bill_no: 'BN 1' }, 'Bill no may contain only letters, digits, dashes and slashes'],
    [{ vendor: 'V', bill_no: 'BN-1' }, 'Bill date is required when setting a bill no'],
    // Column order: Order Date is reported before Vendor.
    [{ po_date: 'bad' }, 'Order Date is not a valid date'],
  ])('%j -> %s', (body, message) => {
    expect(entryFieldsError(body)).toBe(message);
  });

  test('a full entry, a bare one, and a blank form', () => {
    expect(entryFieldsError({
      po_date: '2026-11-20', vendor: 'Balaji Traders', party_name: 'Sharma Stores', vendor_po_id: 'BT-100',
      qty: '120', city: 'Mumbai', expiry_date: '2026-12-20', dispatch_date: '2026-11-22',
      courier: 'Delhivery', tracking_id: 'TRK-1', bill_no: '607/RM/26-27', bill_date: '2026-11-22',
    })).toBeNull();
    expect(entryFieldsError({ vendor: 'V', qty: 0 })).toBeNull();
    expect(entryFieldsError(emptyEntry())).toBe('Vendor is required');
  });

  test('constants match the server', () => {
    expect(FIELDS).toEqual([
      'po_date', 'vendor', 'party_name', 'vendor_po_id', 'qty', 'city',
      'expiry_date', 'dispatch_date', 'courier', 'tracking_id', 'bill_no', 'bill_date',
    ]);
    expect(TEXT_MAX).toBe(200);
    expect(BILL_NO_RE.test('607/RM/26-27')).toBe(true);
  });
});
