const pdf = require('pdf-parse');
const { parseIndianDate } = require('./dates');
const { extractShipToParty } = require('./address');

function fieldByLine(lines, label) {
  const re = new RegExp('^\\s*' + label + '\\s*:\\s*(.+)$', 'i');
  for (const l of lines) {
    const m = l.match(re);
    if (m) return m[1].trim();
  }
  return null;
}

// A Zepto row's numeric tail (concatenated across however many pdf-parse lines):
//   <HSN(8)><EAN(8)><Qty(int)><MRP(2dec)><UnitBase(2dec)><Taxable(2dec)>
//   <CGST_rate(2dec)>%<CGST_amt(2dec)>
//   <SGST_rate(2dec)>%<SGST_amt(2dec)>
//   <IGST_rate(2dec)>%<IGST_amt(2dec)>
//   <CESS_rate(2dec)>%<CESS_amt(2dec)>
//   <AddCess(2dec)><Total(2dec)>
// Qty length varies (1–4 digits in observed specimens). Pick the split where
// qty * unitBase ≈ taxable.
function parseQtyFromBlob(blob) {
  const D = '\\d+\\.\\d{2}';
  for (let qLen = 1; qLen <= 5; qLen++) {
    const re = new RegExp(
      `^(\\d{8})(\\d{8})(\\d{${qLen}})(${D})(${D})(${D})` +
      `(${D})%(${D})(${D})%(${D})(${D})%(${D})(${D})%(${D})` +
      `(${D})(${D})$`
    );
    const m = blob.match(re);
    if (!m) continue;
    const qty = parseInt(m[3], 10);
    const unitBase = parseFloat(m[5]);
    const taxable = parseFloat(m[6]);
    if (qty > 0 && Math.abs(qty * unitBase - taxable) / Math.max(taxable, 1) < 0.005) return qty;
  }
  return null;
}

const NUMERIC_LINE_RE = /^[\d.%]+$/;

async function parseZepto(buffer) {
  const { text } = await pdf(buffer);
  const rawLines = text.split(/\r?\n/).map(l => l.trim());

  const vendor_po_id = (fieldByLine(rawLines, 'PO No') || '').replace(/\s+/g, '');
  const po_date = parseIndianDate(fieldByLine(rawLines, 'PO Date'));
  const expected_delivery_date = parseIndianDate(fieldByLine(rawLines, 'Expected Delivery Date'));
  const po_expiry_date = parseIndianDate(fieldByLine(rawLines, 'PO Expiry Date'));

  if (!vendor_po_id) throw new Error('Could not find PO No in Zepto PDF');

  const flatLines = rawLines.filter(Boolean);
  const headerIdx = flatLines.findIndex(l => /Material Code/i.test(l) && /Item Description/i.test(l));
  const endIdx = flatLines.findIndex(l => /Total Taxable Amount/i.test(l));
  const bodyStart = headerIdx === -1 ? 0 : headerIdx + 1;
  const bodyEnd = endIdx === -1 ? flatLines.length : endIdx;

  const lines = [];
  let i = bodyStart;
  let expectedSr = 1;

  while (i < bodyEnd) {
    const line = flatLines[i];
    const srStr = String(expectedSr);

    // Head: pure-digit line that starts with expectedSr.
    // Common shape: <sr><material(6d)>, e.g. "1310125".
    // Split shape:  "<sr>" alone followed by "<material(6d)>" on next line.
    let item_code = null;
    let j = i + 1;
    if (/^\d+$/.test(line) && line.startsWith(srStr) && line.length >= srStr.length + 5) {
      item_code = line.slice(srStr.length).slice(0, 6);
    } else if (line === srStr && j < bodyEnd && /^\d{6}$/.test(flatLines[j])) {
      item_code = flatLines[j];
      j++;
    } else {
      i++;
      continue;
    }

    // Skip description lines (anything not starting with a digit / decimal / %).
    while (j < bodyEnd && !NUMERIC_LINE_RE.test(flatLines[j])) j++;

    // Accumulate consecutive numeric/percent lines into a single blob,
    // attempting to parse after each append. Stop at first successful parse.
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

  const party_name = extractShipToParty(flatLines);
  return { vendor_po_id, po_date, expected_delivery_date, po_expiry_date, party_name, lines };
}

module.exports = parseZepto;
