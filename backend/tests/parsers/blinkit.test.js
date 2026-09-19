const fs = require('fs');
const path = require('path');
const parseBlinkit = require('../../src/parsers/marketplacePO/blinkit');

const SAMPLES = path.join(__dirname, '..', '..', 'src', 'parsers', 'marketplacePO', 'samples', 'blinkit');

// 50033210046734.pdf is the PO that exposed the wrapped-number bug: pdf-parse
// split row 1's Total Amt across two lines ("...106848.0" / "0"), so that row's
// qty tail never matched, the scanner swallowed row 2's tail in its place, and
// the sequential serial counter desynchronised — leaving a single line item
// carrying row 2's quantity and silently dropping the other nine. Pin the whole
// vector so a regression cannot hide behind a well-formed-looking result.
const WRAPPED_TOTAL_PO = '50033210046734.pdf';
const EXPECTED_LINES = [
  { item_code: '10192283', qty: 636 },
  { item_code: '10182776', qty: 382 },
  { item_code: '10186283', qty: 276 },
  { item_code: '10182923', qty: 154 },
  { item_code: '10186239', qty: 140 },
  { item_code: '10284059', qty: 88 },
  { item_code: '10273582', qty: 66 },
  { item_code: '10182757', qty: 38 },
  { item_code: '10182764', qty: 15 },
  { item_code: '10274421', qty: 3 },
];

describe('Blinkit parser — PO with a wrapped Total Amt', () => {
  let result;

  beforeAll(async () => {
    result = await parseBlinkit(fs.readFileSync(path.join(SAMPLES, WRAPPED_TOTAL_PO)));
  });

  it('parses the header fields', () => {
    expect(result.vendor_po_id).toBe('50033210046734');
    expect(result.po_date).toBe('2026-08-27');
    expect(result.po_expiry_date).toBe('2026-09-26');
    expect(result.party_name).toBe('BLINK COMMERCE PRIVATE LIMITED');
  });

  it('recovers every line item, in order, with the right quantity', () => {
    expect(result.lines.map(l => ({ item_code: l.item_code, qty: l.qty }))).toEqual(EXPECTED_LINES);
  });

  it('matches the total quantity printed on the PO', () => {
    expect(result.lines.reduce((sum, l) => sum + l.qty, 0)).toBe(1798);
  });
});

// Every Blinkit R.O. prints "Total Items" and "Total Quantity" in its footer,
// and the parser now refuses any parse that disagrees with them. Checking each
// sample against its own footer is therefore a real assertion, not a tautology:
// it is the guard itself under test.
describe('Blinkit parser — sample totals agree with each PO footer', () => {
  const files = fs.existsSync(SAMPLES)
    ? fs.readdirSync(SAMPLES).filter(f => f.toLowerCase().endsWith('.pdf'))
    : [];

  it('has samples to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test.each(files)('%s parses without tripping the totals guard', async (file) => {
    const result = await parseBlinkit(fs.readFileSync(path.join(SAMPLES, file)));
    expect(result.lines.length).toBeGreaterThan(0);
    for (const ln of result.lines) {
      expect(String(ln.item_code)).toMatch(/^\d{6,8}$/);
      expect(ln.qty).toBeGreaterThan(0);
    }
  });
});
