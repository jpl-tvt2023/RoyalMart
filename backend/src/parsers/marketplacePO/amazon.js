const XLSX = require('xlsx');
const { parseIndianDate } = require('./dates');

function cellText(v) {
  return v == null ? '' : String(v).replace(/\s+/g, ' ').trim();
}

// Amazon FBA sheets open with a flat key/value header block ("Shipment ID" →
// "FBA15LNPDH37"); the value is the first non-empty cell to the label's right.
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

async function parseAmazon(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error('Amazon FBA workbook has no sheets');
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });

  const vendor_po_id = labelValue(grid, 'Shipment ID');
  if (!vendor_po_id) throw new Error('Could not find Shipment ID in Amazon FBA sheet');

  // The "Name" cell embeds a creation date, e.g. "FBA STA (14/04/2026 07:34)-BLR8".
  let po_date = null;
  const name = labelValue(grid, 'Name');
  if (name) {
    const m = name.match(/(\d{1,2}\/\d{1,2}\/\d{4})/);
    if (m) po_date = parseIndianDate(m[1]);
  }

  // Locate the line-item header row, then map columns by header name.
  const headerIdx = grid.findIndex(row => row.some(c => /^ASIN$/i.test(cellText(c))));
  if (headerIdx === -1) throw new Error('Could not find the SKU table in Amazon FBA sheet');
  const header = grid[headerIdx].map(cellText);
  const asinCol = header.findIndex(h => /^ASIN$/i.test(h));
  const titleCol = header.findIndex(h => /^Title$/i.test(h));
  const qtyCol = header.findIndex(h => /^Shipped$/i.test(h));
  if (asinCol === -1 || qtyCol === -1) throw new Error('Amazon FBA table is missing ASIN/Shipped columns');

  const lines = [];
  for (let r = headerIdx + 1; r < grid.length; r++) {
    const row = grid[r];
    const item_code = cellText(row[asinCol]);
    const qty = parseInt(cellText(row[qtyCol]), 10);
    if (!item_code || !Number.isFinite(qty) || qty <= 0) continue;
    lines.push({
      line_no: lines.length + 1,
      item_code,
      item_desc: titleCol === -1 ? '' : cellText(row[titleCol]),
      qty,
    });
  }

  if (lines.length === 0) throw new Error('No line items found in Amazon FBA sheet');

  return {
    vendor_po_id,
    po_date,
    expected_delivery_date: null,
    po_expiry_date: null,
    party_name: null,
    city: null,
    lines,
  };
}

module.exports = parseAmazon;
