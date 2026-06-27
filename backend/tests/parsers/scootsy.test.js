const fs = require('fs');
const path = require('path');
const parseScootsy = require('../../src/parsers/marketplacePO/scootsy');

const SAMPLES = path.join(__dirname, '..', '..', 'src', 'parsers', 'marketplacePO', 'samples', 'scootsy');

function pdfsIn(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.toLowerCase().endsWith('.pdf'))
    .map(f => path.join(dir, f));
}

const legacyFiles = pdfsIn(path.join(SAMPLES, 'legacy'));
const otbFiles = pdfsIn(path.join(SAMPLES, 'otb'));
const exceptionFiles = pdfsIn(path.join(SAMPLES, 'exception'));
const allFiles = [...legacyFiles, ...otbFiles, ...exceptionFiles];

// A successful Scootsy parse yields a PO number and at least one line item;
// every line has an item code and a positive quantity.
function assertWellFormed(result) {
  expect(result.vendor_po_id).toBeTruthy();
  expect(Array.isArray(result.lines)).toBe(true);
  expect(result.lines.length).toBeGreaterThan(0);
  for (const ln of result.lines) {
    expect(String(ln.item_code).trim()).not.toBe('');
    expect(Number(ln.qty)).toBeGreaterThan(0);
  }
}

describe('Scootsy parser (legacy + OTB layouts)', () => {
  if (allFiles.length === 0) {
    it.skip('no sample PDFs present — add them under src/parsers/marketplacePO/samples/scootsy/{legacy,otb}', () => {});
    return;
  }

  if (legacyFiles.length) {
    test.each(legacyFiles)('parses legacy layout: %s', async (file) => {
      assertWellFormed(await parseScootsy(fs.readFileSync(file)));
    });
  }

  if (otbFiles.length) {
    test.each(otbFiles)('parses OTB layout (with city): %s', async (file) => {
      const result = await parseScootsy(fs.readFileSync(file));
      assertWellFormed(result);
      expect(result.city).toBeTruthy(); // OTB layout carries a destination city
    });
  }

  // Multi-line OTB POs where the wrong (legacy) layout spuriously matches a
  // single stray row. The dispatcher must keep the layout that recovers MORE
  // lines, so the full table comes through — not just one line. Guards the
  // regression where only 1 of 23 lines was parsed.
  if (exceptionFiles.length) {
    test.each(exceptionFiles)('recovers the full line-item table: %s', async (file) => {
      const result = await parseScootsy(fs.readFileSync(file));
      assertWellFormed(result);
      expect(result.lines.length).toBeGreaterThan(5);
    });
  }
});
