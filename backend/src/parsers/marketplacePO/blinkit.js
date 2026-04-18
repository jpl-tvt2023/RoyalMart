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

  const HEAD_RE = /^(\d{1,2})(\d{8})(\d{5})$/;
  const NUM_RE = /^(\d+\.\d{2})(\d+\.\d{2})(\d+)(\d{3,4}\.\d{2})(\d+\.\d{2})$/;

  const lines = [];
  let currentHead = null;
  let descParts = [];

  const flush = (numLine) => {
    if (!currentHead) return;
    const m = numLine.match(NUM_RE);
    if (m) {
      const qty = parseInt(m[3], 10);
      if (qty > 0) {
        const item_desc = descParts.join(' ').replace(/\s+/g, ' ').trim();
        lines.push({
          line_no: currentHead.srNo,
          item_code: currentHead.item_code,
          item_desc,
          qty,
        });
      }
    }
    currentHead = null;
    descParts = [];
  };

  for (let i = 0; i < flat.length; i++) {
    const line = flat[i];
    const head = line.match(HEAD_RE);
    if (head) {
      currentHead = { srNo: parseInt(head[1], 10), item_code: head[2] };
      descParts = [];
      continue;
    }
    if (!currentHead) continue;
    if (NUM_RE.test(line)) { flush(line); continue; }
    if (/^\d{3}$/.test(line)) continue;
    if (/^\d+\.\d+/.test(line)) continue;
    if (/^\d$/.test(line)) continue;
    const upcMatch = line.match(/^(\d{8})(.*)$/);
    if (upcMatch) {
      if (upcMatch[2].trim()) descParts.push(upcMatch[2].trim());
      continue;
    }
    if (/Total Quantity|Total Taxable|Grand Total/i.test(line)) { currentHead = null; break; }
    descParts.push(line);
  }

  return { vendor_po_id, po_date, expected_delivery_date, po_expiry_date, lines };
}

module.exports = parseBlinkit;
