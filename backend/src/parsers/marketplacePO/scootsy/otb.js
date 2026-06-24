const pdf = require('pdf-parse');
const { parseIndianDate } = require('../dates');
const { extractShipToParty, companyAfterShipping } = require('../address');
const { fieldByLabel } = require('./shared');

// New Scootsy "OTB" layout (CREATE_OTB_PURCHASE_ORDER). Same column set as the
// legacy layout, but the Unit Base Cost has a VARIABLE number of decimals
// (e.g. 74.99457, 195.054, 150.40), which breaks the legacy fixed-3dp regex.
//
// A row's numeric tail (concatenated, whitespace stripped):
//   <HSN(8)><Qty(int)><MRP(.2)><UnitBase(.2..7)><Taxable(.2)>
//   <CGSTr(.2)><CGSTa(.2)><SGSTr(.2)><SGSTa(.2)><IGSTr(.2)><IGSTa(.2)>
//   <CESSr(.2)><CESSa(.2)><AddCess(.2)><Total(.2)>
// We brute-force both the qty length and the unit-base decimal count and accept
// the split where qty * unitBase ≈ taxable.
function parseRowFromBlob(blob) {
  const D2 = '\\d+\\.\\d{2}';
  for (let qLen = 1; qLen <= 5; qLen++) {
    for (let ubDec = 2; ubDec <= 7; ubDec++) {
      const UB = `\\d+\\.\\d{${ubDec}}`;
      const re = new RegExp(
        `^(\\d{8})(\\d{${qLen}})(${D2})(${UB})(${D2})` +
        `(${D2})(${D2})(${D2})(${D2})(${D2})(${D2})(${D2})(${D2})` +
        `(${D2})(${D2})$`
      );
      const m = blob.match(re);
      if (!m) continue;
      const qty = parseInt(m[2], 10);
      const unitBase = parseFloat(m[4]);
      const taxable = parseFloat(m[5]);
      if (qty > 0 && Math.abs(qty * unitBase - taxable) / Math.max(taxable, 1) < 0.005) {
        return { qty };
      }
    }
  }
  return null;
}

// City sits in the shipping block as "City, State, 6-digit-PIN". Prefer the line
// after a "Shipping Address" header; fall back to the first such line anywhere.
function extractCity(flatLines) {
  const CITY_RE = /^([A-Za-z][A-Za-z .]+?),\s*[A-Za-z .]+,\s*\d{6}\b/;
  const shipIdx = flatLines.findIndex(l => /shipping\s+address/i.test(l));
  const scanFrom = shipIdx === -1 ? 0 : shipIdx + 1;
  for (let i = scanFrom; i < flatLines.length; i++) {
    const m = flatLines[i].match(CITY_RE);
    if (m) return m[1].trim();
  }
  // Fallback: derive from the Scootsy FC email prefix (e.g. PUNDELHIVERY@, MUMFC22@).
  const emailLine = flatLines.find(l => /@scootsy\.com/i.test(l));
  if (emailLine) {
    const pref = emailLine.match(/\b([A-Z]{3})[A-Z0-9]*@scootsy\.com/i);
    const MAP = { PUN: 'Pune', MUM: 'Mumbai', BLR: 'Bangalore', HYD: 'Hyderabad', DEL: 'Delhi' };
    if (pref && MAP[pref[1].toUpperCase()]) return MAP[pref[1].toUpperCase()];
  }
  return null;
}

async function parseScootsyOtb(buffer) {
  const { text } = await pdf(buffer);
  const rawLines = text.split(/\r?\n/).map(l => l.trim());

  const vendor_po_id = (fieldByLabel(rawLines, 'PO No') || '').replace(/\s+/g, '');
  const po_date = parseIndianDate(fieldByLabel(rawLines, 'PO Date'));
  const expected_delivery_date = parseIndianDate(fieldByLabel(rawLines, 'Expected Delivery Date'));
  const po_expiry_date = parseIndianDate(fieldByLabel(rawLines, 'PO Expiry Date'));

  if (!vendor_po_id) throw new Error('Could not find PO No in Scootsy PDF (OTB)');

  const flatLines = rawLines.filter(Boolean);
  // OTB renders the summary with tabs and the amount appended, e.g.
  // "Total\tAmount\t(INR)4264.33" — match the prefix, not an exact line.
  const endIdx = flatLines.findIndex(l => /^Total\s+Amount\s+\(INR\)/i.test(l));
  const bodyEnd = endIdx === -1 ? flatLines.length : endIdx;

  // A numeric-tail line: only digits, dots and spaces (rates like "2.50 26.25"
  // may share a line). Whitespace is stripped before matching.
  const numericish = (l) => /^[\d.\s]+$/.test(l) && /\d/.test(l);

  const lines = [];
  let i = 0;
  let expectedSr = 1;

  while (i < bodyEnd) {
    const line = flatLines[i];
    const srStr = String(expectedSr);

    // Head: "<sr><code(5-6 digits)>" optionally followed by a non-digit (the
    // description, which pdf-parse glues onto the head line at page breaks, e.g.
    // "1253882Royal Mart..."). The trailing "\D|$" boundary rejects numeric blob
    // lines (HSN+qty+...), which always have another digit right after.
    const head = line.match(new RegExp(`^${srStr}(\\d{5,6})(\\D.*)?$`));
    if (!head) { i++; continue; }
    const item_code = head[1];

    // Description: any inline remainder from the head line, plus following text
    // lines, until the 8-digit HSN that starts the numeric block.
    const descParts = [];
    if (head[2] && head[2].trim()) descParts.push(head[2].trim());
    let j = i + 1;
    while (j < bodyEnd && !/^\d{8}/.test(flatLines[j].replace(/\s/g, ''))) {
      const t = flatLines[j].trim();
      if (t && !/^\d+$/.test(t)) descParts.push(t);
      j++;
    }

    // Accumulate numeric-tail lines and try to parse after each append.
    let blob = '';
    let row = null;
    while (j < bodyEnd && numericish(flatLines[j])) {
      blob += flatLines[j].replace(/\s/g, '');
      j++;
      row = parseRowFromBlob(blob);
      if (row) break;
    }

    if (row && row.qty > 0) {
      lines.push({
        line_no: expectedSr,
        item_code,
        item_desc: descParts.join(' ').replace(/\s+/g, ' ').trim(),
        qty: row.qty,
      });
    }
    expectedSr++;
    i = j > i ? j : i + 1;
  }

  // Buyer entity = the company line after the (combined) Billing/Shipping Address
  // header, e.g. CLOUDSTORE RETAIL PRIVATE LIMITED.
  const party_name = companyAfterShipping(flatLines) || extractShipToParty(flatLines);
  const city = extractCity(flatLines);
  return { vendor_po_id, po_date, expected_delivery_date, po_expiry_date, party_name, city, lines };
}

module.exports = parseScootsyOtb;
