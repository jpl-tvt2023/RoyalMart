const fs = require('fs');
const path = require('path');
const { parse } = require('../../src/parsers/marketplacePO');

const SAMPLES_ROOT = path.join(__dirname, '..', '..', 'src', 'parsers', 'marketplacePO', 'samples');

// Vendor -> sample subfolder. Drop PO files (PDF, or .xls/.xlsx for Flipkart
// Minutes) into these folders and they become regression tests automatically
// (each asserts a well-formed parse).
const VENDORS = {
  Blinkit: 'blinkit',
  Zepto: 'zepto',
  Now: 'Now',
  Minutes: 'Minutes',
};

function samplesIn(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => /\.(pdf|xls|xlsx)$/i.test(f))
    .map(f => path.join(dir, f));
}

function assertWellFormed(result) {
  expect(result.vendor_po_id).toBeTruthy();
  expect(Array.isArray(result.lines)).toBe(true);
  expect(result.lines.length).toBeGreaterThan(0);
  for (const ln of result.lines) {
    expect(String(ln.item_code).trim()).not.toBe('');
    expect(Number(ln.qty)).toBeGreaterThan(0);
  }
}

describe('Vendor PO parsers — sample regression', () => {
  for (const [vendor, sub] of Object.entries(VENDORS)) {
    const files = samplesIn(path.join(SAMPLES_ROOT, sub));
    if (files.length === 0) {
      it.skip(`${vendor}: no samples (add files under samples/${sub}/)`, () => {});
      continue;
    }
    test.each(files)(`${vendor} parses: %s`, async (file) => {
      assertWellFormed(await parse(vendor, fs.readFileSync(file)));
    });
  }
});
