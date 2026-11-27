import { describe, test, expect } from 'vitest';
import JsBarcode from 'jsbarcode';
import {
  batchFieldsError, operatorError, keyError, pinError, labelSizeError, wholeNumberError, printModeError,
  labelPageError, labelPageHeight,
  KEY_RE, PIN_RE, LABEL_COUNT_MAX, PACK_SIZE_MAX, PRINT_MODES, articleLabel, keyCountLabel, printCountLabel,
  scanBatchError, scanFieldsError, SCAN_BATCH_MAX,
} from '../barcodeStation';
import { encodeKey } from '../../pages/BarcodeStation/stationHelpers';

// Twin of backend/src/services/barcodeStation.service.js. The messages are the
// server's, verbatim -- backend tests/barcodeStation.test.js asserts the same
// strings, in the same field order.

const ok = { outbound_vendor_id: 3, article_id: 7, pack_size: 300, label_count: 180 };

describe('batchFieldsError', () => {
  test('a complete entry passes, numbers or digit strings alike', () => {
    expect(batchFieldsError(ok)).toBeNull();
    expect(batchFieldsError({ outbound_vendor_id: '3', article_id: '7', pack_size: ' 300 ', label_count: '180' })).toBeNull();
    // Stitching / Packing is optional (105): blank or a picked id.
    expect(batchFieldsError({ ...ok, stitching_party_id: '' })).toBeNull();
    expect(batchFieldsError({ ...ok, stitching_party_id: null })).toBeNull();
    expect(batchFieldsError({ ...ok, stitching_party_id: '4' })).toBeNull();
  });

  test('fields are reported in grid order', () => {
    expect(batchFieldsError({})).toBe('Vendor is required');
    expect(batchFieldsError({ ...ok, outbound_vendor_id: '', article_id: '' })).toBe('Vendor is required');
    expect(batchFieldsError({ ...ok, article_id: null })).toBe('Article is required');
    expect(batchFieldsError({ ...ok, pack_size: '' })).toBe('Pack Size is required');
    expect(batchFieldsError({ ...ok, label_count: '' })).toBe('Number of Barcodes is required');
    // No floor any more (106): an entry without one is complete.
    expect(batchFieldsError({ ...ok, floor_id: undefined })).toBeNull();
    // Vendor, Stitching / Packing, Article
    expect(batchFieldsError({ ...ok, stitching_party_id: 'x' })).toBe('Stitching / Packing must be picked from the list');
    expect(batchFieldsError({ ...ok, stitching_party_id: '0' })).toBe('Stitching / Packing must be picked from the list');
    expect(batchFieldsError({ ...ok, outbound_vendor_id: '', stitching_party_id: 'x' })).toBe('Vendor is required');
    expect(batchFieldsError({ ...ok, stitching_party_id: 'x', article_id: '' })).toBe('Stitching / Packing must be picked from the list');
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
    expect(labelSizeError(5, 51)).toBe('Sticker width must be from 20 to 300 mm, at most one decimal');
    expect(labelSizeError(152, '')).toBe('Sticker height is required');
    expect(labelSizeError(152, 48.25)).toBe('Sticker height must be from 10 to 300 mm, at most one decimal');
    expect(labelSizeError(152, 51)).toBeNull();
    expect(labelSizeError('150', '48.2')).toBeNull();
  });

  // Migration 104: the TSC TA210 roll -- two 150 x 48.2 stickers per page.
  test('label page', () => {
    expect(labelPageHeight(48.2, 2, 4, 1.3)).toBe(103);
    expect(labelPageHeight(51, 1, 0, 0)).toBe(51);
    expect(labelPageError(2, 4, 1.3, 48.2)).toBeNull();
    expect(labelPageError(1, 0, 0, 51)).toBeNull();
    expect(labelPageError(0, 0, 0, 51)).toBe('Stickers per page must be at least 1');
    expect(labelPageError(5, 0, 0, 51)).toBe('Stickers per page cannot be more than 4');
    expect(labelPageError(1.5, 0, 0, 51)).toBe('Stickers per page must be a whole number');
    expect(labelPageError(2, 21, 0, 51)).toBe('Gap between stickers must be from 0 to 20 mm, at most one decimal');
    expect(labelPageError(2, 4, -1, 51)).toBe('Top and bottom margin must be from 0 to 20 mm, at most one decimal');
    expect(labelPageError(3, 4, 1.3, 100)).toBe('The page cannot be taller than 300 mm');
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

// Stock counts (migration 102). Same messages as backend tests/stockCount.test.js.
describe('scan request rules', () => {
  test('the batch limit matches the server', () => {
    expect(SCAN_BATCH_MAX).toBe(200);
  });

  test('scanBatchError', () => {
    expect(scanBatchError(['48213907'])).toBeNull();
    expect(scanBatchError([])).toBe('Scan at least one key');
    expect(scanBatchError(undefined)).toBe('Scan at least one key');
    expect(scanBatchError(Array(201).fill('48213907'))).toBe('Send at most 200 keys at a time');
    expect(scanBatchError(['48213907', '1234'])).toBe('Every key must be 8 digits');
    expect(scanBatchError(['04821390'])).toBe('Every key must be 8 digits');
  });

  test('scanFieldsError checks the floor first, then the keys', () => {
    expect(scanFieldsError({ floor_id: 2, keys: ['48213907'] })).toBeNull();
    expect(scanFieldsError({ keys: [] })).toBe('Floor is required');
    expect(scanFieldsError({ floor_id: '', keys: ['48213907'] })).toBe('Floor is required');
    expect(scanFieldsError({ floor_id: '2', keys: [] })).toBe('Scan at least one key');
  });
});
