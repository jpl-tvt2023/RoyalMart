const pdf = require('pdf-parse');
const { parseIndianDate } = require('./dates');

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
  const flat = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

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
    if (/^\d+$/.test(line) && line.startsWith(srStr) && line.length >= srStr.length + 6) {
      let item_code = line.slice(srStr.length);
      let j = i + 1;
      while (item_code.length < 8 && j < end && /^\d+$/.test(flat[j])) {
        item_code += flat[j];
        j++;
      }
      item_code = item_code.slice(0, 8);
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
    } else {
      i++;
    }
  }

  return { vendor_po_id, po_date, expected_delivery_date, po_expiry_date, lines };
}

module.exports = parseBlinkit;
