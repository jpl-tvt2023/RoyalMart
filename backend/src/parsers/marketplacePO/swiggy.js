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

async function parseSwiggy(buffer) {
  const { text } = await pdf(buffer);
  const flat = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  const vendor_po_id = (fieldByLine(flat, 'PO No') || '').replace(/\s+/g, '');
  const po_date = parseIndianDate(fieldByLine(flat, 'PO Date'));
  const expected_delivery_date = parseIndianDate(fieldByLine(flat, 'Expected Delivery Date'));
  const po_expiry_date = parseIndianDate(fieldByLine(flat, 'PO Expiry Date'));

  if (!vendor_po_id) throw new Error('Could not find PO No in Swiggy PDF');

  const HEAD_RE = /^(\d{1,2})(\d{6,7})$/;
  const HSN_QTY_RE = /^(\d{8})(\d+)$/;

  const tableEnd = flat.findIndex(l => /Total Amount \(INR\)/i.test(l));
  const end = tableEnd === -1 ? flat.length : tableEnd;

  const lines = [];
  let i = 0;
  while (i < end) {
    const head = flat[i].match(HEAD_RE);
    if (!head) { i++; continue; }
    const srNo = parseInt(head[1], 10);
    const item_code = head[2];

    let j = i + 1;
    const descParts = [];
    let qty = null;
    while (j < end) {
      const hqm = flat[j].match(HSN_QTY_RE);
      if (hqm) {
        qty = parseInt(hqm[2], 10);
        j++;
        break;
      }
      if (HEAD_RE.test(flat[j])) break;
      descParts.push(flat[j]);
      j++;
    }

    const item_desc = descParts.join(' ').replace(/\s+/g, ' ').trim();
    if (item_code && qty) lines.push({ line_no: srNo, item_code, item_desc, qty });

    while (j < end && !HEAD_RE.test(flat[j])) j++;
    i = j;
  }

  return { vendor_po_id, po_date, expected_delivery_date, po_expiry_date, lines };
}

module.exports = parseSwiggy;
