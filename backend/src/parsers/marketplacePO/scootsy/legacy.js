const pdf = require('pdf-parse');
const { parseIndianDate } = require('../dates');
const { extractShipToParty, companyAfterShipping } = require('../address');
const { fieldByLabel, NUMERIC_LINE_RE } = require('./shared');

// Legacy Scootsy layout. A row's numeric tail (concatenated across however many
// pdf-parse lines):
//   <HSN(8)><Qty(int)><MRP(2dec)><UnitBase(3dec)><Taxable(2dec)>
//   <CGST_rate(2dec)><CGST_amt(2dec)>
//   <SGST_rate(2dec)><SGST_amt(2dec)>
//   <IGST_rate(2dec)><IGST_amt(2dec)>
//   <CESS_rate(2dec)><CESS_amt(2dec)>
//   <AddCess(2dec)><Total(2dec)>
// Pick the qty length where qty * unitBase ≈ taxable.
function parseQtyFromBlob(blob) {
  const D2 = '\\d+\\.\\d{2}';
  const D3 = '\\d+\\.\\d{3}';
  for (let qLen = 1; qLen <= 5; qLen++) {
    const re = new RegExp(
      `^(\\d{8})(\\d{${qLen}})(${D2})(${D3})(${D2})` +
      `(${D2})(${D2})(${D2})(${D2})(${D2})(${D2})(${D2})(${D2})` +
      `(${D2})(${D2})$`
    );
    const m = blob.match(re);
    if (!m) continue;
    const qty = parseInt(m[2], 10);
    const unitBase = parseFloat(m[4]);
    const taxable = parseFloat(m[5]);
    if (qty > 0 && Math.abs(qty * unitBase - taxable) / Math.max(taxable, 1) < 0.005) return qty;
  }
  return null;
}

async function parseScootsyLegacy(buffer) {
  const { text } = await pdf(buffer);
  const rawLines = text.split(/\r?\n/).map(l => l.trim());

  const vendor_po_id = (fieldByLabel(rawLines, 'PO No') || '').replace(/\s+/g, '');
  const po_date = parseIndianDate(fieldByLabel(rawLines, 'PO Date'));
  const expected_delivery_date = parseIndianDate(fieldByLabel(rawLines, 'Expected Delivery Date'));
  const po_expiry_date = parseIndianDate(fieldByLabel(rawLines, 'PO Expiry Date'));

  if (!vendor_po_id) throw new Error('Could not find PO No in Scootsy PDF');

  const flatLines = rawLines.filter(Boolean);
  // Body starts after the table header (the last "RateAmt" / "(INR)" header line).
  // End is the per-table summary "Total Amount (INR)" line.
  const endIdx = flatLines.findIndex(l => /^Total Amount \(INR\)$/i.test(l));
  const bodyEnd = endIdx === -1 ? flatLines.length : endIdx;

  const lines = [];
  let i = 0;
  let expectedSr = 1;

  while (i < bodyEnd) {
    const line = flatLines[i];
    const srStr = String(expectedSr);

    // Head: a pure-digit line starting with expectedSr that contains at least
    // 5 trailing digits (item code is 5 or 6 digits).
    if (!/^\d+$/.test(line) || !line.startsWith(srStr) || line.length < srStr.length + 5) {
      i++;
      continue;
    }
    const item_code = line.slice(srStr.length).slice(0, 6);
    let j = i + 1;

    // Skip description lines. Beware: descriptions can contain numeric-only
    // fragments like "2.0" or "1.0" (from "2.0 Pieces"), so we skip until we
    // find a line that begins with 8 consecutive digits — the HSN code.
    while (j < bodyEnd && !/^\d{8}/.test(flatLines[j])) j++;

    // Accumulate consecutive numeric lines and try to parse after each append.
    let blob = '';
    let qty = null;
    while (j < bodyEnd && NUMERIC_LINE_RE.test(flatLines[j])) {
      blob += flatLines[j];
      j++;
      qty = parseQtyFromBlob(blob);
      if (qty != null) break;
    }

    if (qty != null && qty > 0) {
      lines.push({ line_no: expectedSr, item_code, item_desc: '', qty });
    }
    expectedSr++;
    i = j;
  }

  // Buyer entity = the company line after the (combined) Billing/Shipping header.
  const party_name = companyAfterShipping(flatLines) || extractShipToParty(flatLines);
  return { vendor_po_id, po_date, expected_delivery_date, po_expiry_date, party_name, city: null, lines };
}

module.exports = parseScootsyLegacy;
