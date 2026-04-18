const pdf = require('pdf-parse');
const { parseIndianDate } = require('./dates');

const UUID_RE = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi;

function fieldByLine(lines, label) {
  const re = new RegExp('^\\s*' + label + '\\s*:\\s*(.+)$', 'i');
  for (const l of lines) {
    const m = l.match(re);
    if (m) return m[1].trim();
  }
  return null;
}

async function parseZepto(buffer) {
  const { text } = await pdf(buffer);
  const rawLines = text.split(/\r?\n/).map(l => l.trim());

  const vendor_po_id = (fieldByLine(rawLines, 'PO No') || '').replace(/\s+/g, '');
  const po_date = parseIndianDate(fieldByLine(rawLines, 'PO Date'));
  const expected_delivery_date = parseIndianDate(fieldByLine(rawLines, 'Expected Delivery Date'));
  const po_expiry_date = parseIndianDate(fieldByLine(rawLines, 'PO Expiry Date'));

  if (!vendor_po_id) throw new Error('Could not find PO No in Zepto PDF');

  const joinedNoNewlines = text.replace(/\s*\n\s*/g, '');
  const uuids = [...joinedNoNewlines.matchAll(UUID_RE)];
  const flatLines = rawLines.filter(Boolean);

  const headerIdx = flatLines.findIndex(l => /Material Code/i.test(l) && /Item Description/i.test(l));
  const endIdx = flatLines.findIndex(l => /Total Taxable Amount/i.test(l));
  const body = flatLines.slice(headerIdx + 1, endIdx === -1 ? undefined : endIdx);

  const lines = [];
  let i = 0;
  while (i < body.length) {
    const head = body[i].match(/^(\d{1,2})(\d{6,7})$/);
    if (!head) { i++; continue; }
    const srNo = parseInt(head[1], 10);
    const item_code = head[2];

    const descParts = [];
    let j = i + 1;
    while (j < body.length && !/^[a-f0-9]{8}-[a-f0-9]{4}-/i.test(body[j])) {
      descParts.push(body[j]);
      j++;
    }
    while (j < body.length && /^[a-f0-9-]+$/i.test(body[j]) && /-/.test(body[j])) j++;

    if (j >= body.length) break;
    let numericBlob = '';
    while (j < body.length && /^[\d.]/.test(body[j]) && !/^(\d{1,2})(\d{6,7})$/.test(body[j])) {
      numericBlob += body[j];
      j++;
    }
    const m = numericBlob.match(/^(\d{16})(\d+?)(\d{2,3}\.00)(\d+\.\d{2})/);
    const qty = m ? parseInt(m[2], 10) : null;

    const item_desc = descParts.join(' ').replace(/\s+/g, ' ').trim();
    if (item_code && qty) lines.push({ line_no: srNo, item_code, item_desc, qty });

    i = j;
  }

  if (lines.length === 0 && uuids.length > 0) {
  }

  return { vendor_po_id, po_date, expected_delivery_date, po_expiry_date, lines };
}

module.exports = parseZepto;
