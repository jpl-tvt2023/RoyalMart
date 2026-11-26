import { describe, test, expect } from 'vitest';
import JsBarcode from 'jsbarcode';
import {
  batchFieldsError, operatorError, keyError, pinError, labelSizeError, wholeNumberError, printModeError,
  KEY_RE, PIN_RE, LABEL_COUNT_MAX, PACK_SIZE_MAX, PRINT_MODES, articleLabel, keyCountLabel, printCountLabel,
} from '../barcodeStation';
import { encodeKey } from '../../pages/BarcodeStation/stationHelpers';

// Twin of backend/src/services/barcodeStation.service.js. The messages are the
// server's, verbatim -- backend tests/barcodeStation.test.js asserts the same
// strings, in the same field order.

const ok = { outbound_vendor_id: 3, article_id: 7, pack_size: 300, floor_id: 2, label_count: 180 };

describe('batchFieldsError', () => {
  test('a complete entry passes, numbers or digit strings alike', () => {
    expect(batchFieldsError(ok)).toBeNull();
    expect(batchFieldsError({ outbound_vendor_id: '3', article_id: '7', pack_size: ' 300 ', floor_id: '2', label_count: '180' })).toBeNull();
  });

  test('fields are reported in grid order', () => {
    expect(batchFieldsError({})).toBe('Vendor is required');
    expect(batchFieldsError({ ...ok, outbound_vendor_id: '', article_id: '' })).toBe('Vendor is required');
    expect(batchFieldsError({ ...ok, article_id: null })).toBe('Article is required');
    expect(batchFieldsError({ ...ok, pack_size: '' })).toBe('Pack Size is required');
    expect(batchFieldsError({ ...ok, floor_id: undefined })).toBe('Floor is required');
    expect(batchFieldsError({ ...ok, label_count: '' })).toBe('Number of Barcodes is required');
    expect(batchFieldsError({ ...ok, pack_size: '', floor_id: '' })).toBe('Pack Size is required');
  });

  test('the same limits and messages as the server', () => {
    expect(batchFieldsError({ ...ok, pack_size: '3.5' })).toBe('Pack Size must be a whole number');
    expect(batchFieldsError({ ...ok, pack_size: '0' })).toBe('Pack Size must be at least 1');
    expect(batchFieldsError({ ...ok, pack_size: PACK_SIZE_MAX + 1 })).toBe('Pack Size cannot be more than 1000000');
    expect(batchFieldsError({ ...ok, label_count: LABEL_COUNT_MAX + 1 })).toBe('Number of Barcodes cannot be more than 2000');
    expect(batchFieldsError({ ...ok, label_count: LABEL_COUNT_MAX })).toBeNull();
  });

  test('"300.0", "3e2" and "-1" are not whole numbers on either side', () => {
    for (const v of ['300.0', '3e2', '-1', 'abc']) {
      expect(wholeNumberError(v, 'Pack Size', 10)).toBe('Pack Size must be a whole number');
    }
  });
});

describe('operator, key and PIN', () => {
  test('operator', () => {
    expect(operatorError('  ')).toBe('Operator name is required');
    expect(operatorError('x'.repeat(61))).toBe('Operator name cannot be longer than 60 characters');
    expect(operatorError('Ramesh Kumar')).toBeNull();
  });

  test('print mode: dialog or direct (migration 100)', () => {
    expect(PRINT_MODES).toEqual(['dialog', 'direct']);
    expect(printModeError('dialog')).toBeNull();
    expect(printModeError('direct')).toBeNull();
    for (const bad of ['fax', '', null, 'Direct']) expect(printModeError(bad)).toBe('Print mode must be dialog or direct');
  });

  test('key', () => {
    expect(keyError('')).toBe('Key is required');
    for (const bad of ['abc', '01234567', '1234567', '123456789']) expect(keyError(bad)).toBe('Key must be 8 digits');
    expect(keyError('38417290')).toBeNull();
    expect(KEY_RE.source).toBe('^[1-9]\\d{7}$');
  });

  test('PIN', () => {
    expect(pinError('')).toBe('PIN is required');
    for (const bad of ['123', '123456789', 'abcd', '12 34']) expect(pinError(bad)).toBe('PIN must be 4 to 8 digits');
    expect(pinError('4826')).toBeNull();
    expect(pinError('12345678')).toBeNull();
    expect(PIN_RE.source).toBe('^\\d{4,8}$');
  });

  test('sticker size', () => {
    expect(labelSizeError(5, 51)).toBe('Sticker width must be a whole number of mm from 20 to 300');
    expect(labelSizeError(152, '')).toBe('Sticker height is required');
    expect(labelSizeError(152, 51)).toBeNull();
  });
});

describe('labels', () => {
  test('article and key count', () => {
    expect(articleLabel({ category: 'Packaging', item_name: 'One Ply', variant: '3pc Silver handkerchief box' }))
      .toBe('Packaging · One Ply · 3pc Silver handkerchief box');
    expect(articleLabel({ category: 'Barcode', item_name: 'EAN', variant: null })).toBe('Barcode · EAN');
    expect(keyCountLabel(180)).toBe('180 keys');
    expect(keyCountLabel(1)).toBe('1 key');
    expect(printCountLabel(0)).toBe('not printed yet');
    expect(printCountLabel(2)).toBe('printed 2×');
  });
});

describe('Code128 encoding of a key', () => {
  test('an 8-digit key encodes in set C: start C, 79 modules with check and stop', () => {
    const bits = encodeKey(JsBarcode, '10000001');
    expect(bits).toHaveLength(79);
    expect(bits.startsWith('11010011100')).toBe(true);  // Start C
    expect(bits.endsWith('1100011101011')).toBe(true);  // Stop
    expect(/^[01]+$/.test(bits)).toBe(true);
  });
});
