const pdf = require('pdf-parse');
const { parseIndianDate } = require('./dates');
const { extractShipToParty } = require('./address');

function fieldByLine(lines, label) {
  for (let i = 0; i < lines.length; i++) {
    const re = new RegExp('^\\s*' + label + '\\s*:\\s*(.*)$', 'i');
    const m = lines[i].match(re);
    if (m) {
      const same = m[1].trim();
      if (same) return same;
      for (let k = i + 1; k < lines.length; k++) {
        if (lines[k].trim()) return lines[k].trim();
      }
    }
  }
  return null;
}

// Buyer entity for Blinkit = the company under the "Issued by … Seller Hub"
// banner (always BLINK COMMERCE PRIVATE LIMITED). The R.O. layout has no
// "Shipping Address" header, so anchor on that banner and take the first
// company-like line after it (the seller, ROYMAX …, appears later).
function extractBlinkitParty(flat) {
  const idx = flat.findIndex(l => /issued by .*seller hub/i.test(l));
  const start = idx === -1 ? 0 : idx + 1;
  for (let k = start; k < flat.length; k++) {
    const v = (flat[k] || '').trim();
    if (/(private limited|pvt\.?\s*ltd|\blimited\b|\bllp\b)/i.test(v)) {
      return v.replace(/\s*\(.*$/, '').trim();
    }
  }
  return null;
}

// pdf-parse starts a new line on every Y-transform change, so a number that
// wraps inside a narrow table cell arrives split across two lines — a row's
// Total Amt showing up as "…106848.0" then "0". An unrepaired tail fails
// QTY_TAIL_SHAPE below, and the row scanner then walks on and swallows the NEXT
// row's tail, which desynchronises the serial counter and silently drops every
// remaining row. Rejoin the fragments before anything else looks at the lines.
//
// The guard is deliberately narrow — the previous line must end in a decimal
// point, or in a single digit that follows one — so it never welds an item-code
// fragment ("11019228" / "3") or a UPC ("9000009" / "9") onto its neighbour.
// Those wrap the same way and must stay split for the head matcher.
function rejoinWrappedNumbers(lines) {
  const out = [];
  for (const l of lines) {
    if (out.length && /\.\d?$/.test(out[out.length - 1]) && /^\d{1,2}$/.test(l)) {
      out[out.length - 1] += l;
    } else {
      out.push(l);
    }
  }
  return out;
}

function findMultilineField(lines, labelParts) {
  for (let i = 0; i < lines.length - labelParts.length; i++) {
    let ok = true;
    for (let k = 0; k < labelParts.length; k++) {
      if (!new RegExp('^' + labelParts[k] + '$', 'i').test(lines[i + k])) { ok = false; break; }
    }
    if (ok) {
      for (let k = i + labelParts.length; k < lines.length; k++) {
        const m = lines[k].match(/^\s*:?\s*(.+)$/);
        if (m && m[1].trim()) return m[1].trim();
      }
    }
  }
  return null;
}

async function parseBlinkit(buffer) {
  const { text } = await pdf(buffer);
  const flat = rejoinWrappedNumbers(text.split(/\r?\n/).map(l => l.trim()).filter(Boolean));

  const vendor_po_id = (fieldByLine(flat, 'R\\.O\\.\\s*Number') || '').replace(/\s+/g, '');
  let dateRaw = fieldByLine(flat, 'Date');
  if (dateRaw && /^R\.O\./i.test(dateRaw)) dateRaw = null;
  const po_date = parseIndianDate(dateRaw);

  let expiryRaw = fieldByLine(flat, 'R\\.O\\.\\s*expiry date');
  if (!expiryRaw) expiryRaw = findMultilineField(flat, ['R\\.O\\. expiry', 'date']);
  const po_expiry_date = parseIndianDate(expiryRaw);
  const expected_delivery_date = null;

  if (!vendor_po_id) throw new Error('Could not find R.O. Number in Blinkit PDF');

  // Qty-bearing tail: Tax + Landing + Qty + MRP + Total, all glued with no separators.
  // Tax may have 1 or 2 decimals; Landing/MRP/Total are .00. The split between
  // qty digits and MRP digits is ambiguous from the string alone (e.g.
  // "208249.00" could be qty=208 + MRP=249.00, or qty=2 + MRP=8249.00),
  // so we enumerate splits and pick the one where qty * landing == total.
  const parseQtyTail = (line) => {
    for (const taxDec of [2, 1]) {
      for (let qLen = 1; qLen <= 6; qLen++) {
        const re = new RegExp(`^(\\d+\\.\\d{${taxDec}})(\\d+\\.\\d{2})(\\d{${qLen}})(\\d+\\.\\d{2})(\\d+\\.\\d{2})$`);
        const m = line.match(re);
        if (!m) continue;
        const landing = parseFloat(m[2]);
        const qty = parseInt(m[3], 10);
        const total = parseFloat(m[5]);
        if (qty > 0 && Math.abs(qty * landing - total) < 0.01) return qty;
      }
    }
    return null;
  };
  const QTY_TAIL_SHAPE = /^\d+\.\d{1,2}\d+\.\d{2}\d+\d+\.\d{2}\d+\.\d{2}$/;

  const endIdx = flat.findIndex(l => /^Total\s+Quantity/i.test(l));
  const end = endIdx === -1 ? flat.length : endIdx;

  const lines = [];
  let i = 0;
  let expectedSr = 1;
  while (i < end) {
    const line = flat[i];
    const srStr = String(expectedSr);
    let item_code = null;
    let j = i + 1;

    if (/^\d+$/.test(line) && line.startsWith(srStr) && line.length >= srStr.length + 6) {
      item_code = line.slice(srStr.length);
      while (item_code.length < 8 && j < end && /^\d+$/.test(flat[j])) {
        item_code += flat[j];
        j++;
      }
      item_code = item_code.slice(0, 8);
    } else {
      // Page-break fallback: pdf-parse can glue the next row's head onto its
      // description, e.g. "1234567Item name…". Match "<sr><code(6-8d)>" followed
      // by a non-digit. Acceptance is still gated by the qty arithmetic below.
      const merged = line.match(new RegExp(`^${srStr}(\\d{6,8})(\\D.*)?$`));
      if (merged) {
        item_code = merged[1].slice(0, 8);
      } else {
        i++;
        continue;
      }
    }

    let qty = null;
    while (j < end) {
      if (QTY_TAIL_SHAPE.test(flat[j])) {
        qty = parseQtyTail(flat[j]);
        j++;
        break;
      }
      j++;
    }
    if (qty != null && qty > 0) {
      lines.push({ line_no: expectedSr, item_code, item_desc: '', qty });
    }
    expectedSr++;
    i = j;
  }

  // The R.O. prints its own totals in the footer, so check the parse against
  // them. Without this a layout the scanner half-understands yields a
  // well-formed PO that is quietly missing rows — the failure mode that shipped
  // a 1-line preview of a 10-line PO, with a real item code and a real quantity
  // that belonged to a different row, ready to be approved. A loud parse error
  // is always the better outcome. Only assert when both totals were found, so
  // an unseen footer degrades instead of hard-failing.
  const joined = flat.join('\n');
  const footerNum = (label) => {
    const m = joined.match(new RegExp(`Total\\s*${label}\\s*:?\\s*(\\d+)`, 'i'));
    return m ? parseInt(m[1], 10) : null;
  };
  const totalItems = footerNum('Items');
  const totalQty = footerNum('Quantity');
  const parsedQty = lines.reduce((sum, l) => sum + l.qty, 0);
  if (totalItems != null && totalQty != null
      && (lines.length !== totalItems || parsedQty !== totalQty)) {
    throw new Error(
      `Blinkit PDF line table not fully recognised: parsed ${lines.length} of ${totalItems} items `
      + `(quantity ${parsedQty} of ${totalQty})`
    );
  }

  const party_name = extractBlinkitParty(flat) || extractShipToParty(flat);
  return { vendor_po_id, po_date, expected_delivery_date, po_expiry_date, party_name, lines };
}

module.exports = parseBlinkit;
