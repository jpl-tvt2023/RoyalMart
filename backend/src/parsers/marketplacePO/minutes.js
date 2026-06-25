const XLSX = require('xlsx');
const { parseIndianDate } = require('./dates');

function cellText(v) {
  return v == null ? '' : String(v).replace(/\s+/g, ' ').trim();
}

// Find the value for a label cell — the first non-empty cell to its right on
// the same row. Flipkart's sheet is a flat key/value grid where the value is
// usually adjacent ("PO#" → "FCAWG…") but sometimes separated by blank cells
// from a merged column ("BILLED TO ADDRESS" → … → "<address>").
function labelValue(grid, label) {
  const target = label.toLowerCase();
  for (const row of grid) {
    for (let c = 0; c < row.length; c++) {
      if (cellText(row[c]).toLowerCase() === target) {
        for (let k = c + 1; k < row.length; k++) {
          const next = cellText(row[k]);
          if (next) return next;
        }
      }
    }
  }
  return null;
}

function extractCity(address) {
  const a = cellText(address);
  if (!a) return null;
  // Address tails with "<City> <6-digit pincode>", e.g. "… Coimbatore 641402".
  let m = a.match(/([A-Za-z][A-Za-z .]*?)\s+\d{6}\s*$/);
  if (m) return m[1].trim();
  // Fallback: "<City>, <State>- <pincode>".
  m = a.match(/,\s*([A-Za-z][A-Za-z ]+?)\s*,\s*[A-Za-z ]+-?\s*\d{6}/);
  return m ? m[1].trim() : null;
}

async function parseMinutes(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error('Flipkart Minutes workbook has no sheets');
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });

  let vendor_po_id = labelValue(grid, 'PO#');
  if (!vendor_po_id) {
    // Fall back to the "PURCHASE ORDER # XXXX" header or the sheet name.
    const flat = grid.map(r => r.map(cellText).join(' ')).join(' ') + ' ' + (wb.SheetNames[0] || '');
    const m = flat.match(/(?:PURCHASE ORDER #|PO[#\s])\s*([A-Z0-9]{6,})/i);
    if (m) vendor_po_id = m[1];
  }
  if (!vendor_po_id) throw new Error('Could not find PO number in Flipkart Minutes sheet');

  const po_date = parseIndianDate(labelValue(grid, 'ORDER DATE'));
  const po_expiry_date = parseIndianDate(labelValue(grid, 'PO Expiry'));

  const billed = labelValue(grid, 'BILLED TO ADDRESS') || '';
  const party_name = billed ? billed.split(',')[0].trim() || null : null;
  const city = extractCity(billed);

  // Locate the line-item header row, then map columns by header name.
  const headerIdx = grid.findIndex(row => row.some(c => /^FSN\/ISBN13$/i.test(cellText(c))));
  if (headerIdx === -1) throw new Error('Could not find the order-details table in Flipkart Minutes sheet');
  const header = grid[headerIdx].map(cellText);
  const fsnCol = header.findIndex(h => /^FSN\/ISBN13$/i.test(h));
  const qtyCol = header.findIndex(h => /^Quantity$/i.test(h));
  const titleCol = header.findIndex(h => /^Title$/i.test(h));
  if (fsnCol === -1 || qtyCol === -1) throw new Error('Flipkart Minutes table is missing FSN/Quantity columns');

  const lines = [];
  for (let r = headerIdx + 1; r < grid.length; r++) {
    const row = grid[r];
    const first = cellText(row[0]);
    if (/^Total Quantity=?/i.test(first)) break;
    const item_code = cellText(row[fsnCol]);
    const qty = parseInt(cellText(row[qtyCol]), 10);
    if (!item_code || !Number.isFinite(qty) || qty <= 0) continue;
    lines.push({
      line_no: lines.length + 1,
      item_code,
      item_desc: titleCol === -1 ? '' : cellText(row[titleCol]),
      qty,
    });
  }

  if (lines.length === 0) throw new Error('No line items found in Flipkart Minutes sheet');

  return {
    vendor_po_id,
    po_date,
    expected_delivery_date: null,
    po_expiry_date,
    party_name,
    city,
    lines,
  };
}

module.exports = parseMinutes;
