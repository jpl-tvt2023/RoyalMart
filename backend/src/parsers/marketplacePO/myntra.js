const XLSX = require('xlsx');
const { parseIndianDate } = require('./dates');

// Myntra (xlsx). Not a classic PO document: one sheet, one header row, then a
// row per SKU, with columns such as
//   Slot Date (yyyy-MM-dd) | PO Barcode/STR Barcode | Vendor GST Registration No |
//   SKU Code | HSN Code | Invoice No/STN Invoice No | Invoice Date (yyyy-MM-dd) |
//   Quantity | Unit Price Excluding Taxes | Total Cost Excluding Taxes [...] |
//   ... GST ... | Carton Number | Status & Remarks
//
// What ROMS takes from it (client, 2026-11-22):
//   PO Barcode   -> vendor_po_id (one PO per file, so every row must agree)
//   Invoice Date -> po_date (the file has no PO date of its own)
//   Slot Date    -> appointment_date (the delivery slot at Myntra's warehouse)
//   SKU Code     -> item_code, a Myntra-side code mapped under Vendor Codes
//   Quantity     -> qty, summed when one SKU spans several cartons
// The invoice number, prices, GST and cartons are not kept -- Bill No arrives
// on the Builty page or from RAMS, and ROMS holds no financial data. Unit Price
// and Total Cost are read only to cross-check each row (see below).
//
// Columns are found by header LABEL, not position, and the "(yyyy-MM-dd)"
// suffixes are not required, so a reordered or relabelled export still parses.

const cellText = (v) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim());

const COLUMNS = {
  barcode: /^po barcode/i,
  sku: /^sku code$/i,
  qty: /^quantity$/i,
  invoiceDate: /^invoice date/i,
  slotDate: /^slot date/i,
  unitPrice: /^unit price/i,
  totalExTax: /^total cost excluding/i,
};

// A row-level cross-check: Quantity x Unit Price must come to the Total Cost
// the sheet prints beside them, to within a rupee. A shifted or misread
// column fails the upload loudly instead of previewing a plausible wrong PO
// (the lesson of blinkit.js's footer check).
const TOTAL_TOLERANCE = 1;

// A date cell is either text ("2026-11-20", "20/11/2026") or, when Excel typed
// it, a serial day number.
function cellDate(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') {
    const d = XLSX.SSF.parse_date_code(v);
    if (!d || !d.y) return null;
    return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
  }
  return parseIndianDate(cellText(v));
}

function cellNumber(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  const n = Number(cellText(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

// The earliest of the distinct dates seen, so the result does not depend on
// row order if a file ever carries more than one.
const earliest = (dates) => dates.filter(Boolean).sort()[0] || null;

async function parseMyntra(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error('Myntra workbook has no sheets');
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });

  const headerIdx = grid.findIndex(row => row.some(c => COLUMNS.barcode.test(cellText(c)))
    && row.some(c => COLUMNS.sku.test(cellText(c))));
  if (headerIdx === -1) {
    throw new Error('Could not find the header row (PO Barcode, SKU Code) in the Myntra sheet');
  }
  const header = grid[headerIdx].map(cellText);
  const col = {};
  for (const [key, re] of Object.entries(COLUMNS)) col[key] = header.findIndex(h => re.test(h));
  if (col.qty === -1) throw new Error('Myntra sheet is missing the Quantity column');

  const barcodes = new Set();
  const invoiceDates = [];
  const slotDates = [];
  const bySku = new Map();

  for (let r = headerIdx + 1; r < grid.length; r++) {
    const row = grid[r] || [];
    const at = (k) => (col[k] === -1 ? null : row[col[k]]);
    const sku = cellText(at('sku'));
    const qtyRaw = at('qty');
    if (!sku && (qtyRaw == null || qtyRaw === '')) continue; // blank row

    const rowNo = r + 1; // as Excel numbers it
    if (!sku) throw new Error(`Row ${rowNo} of the Myntra sheet has a Quantity but no SKU Code`);
    const qty = cellNumber(qtyRaw);
    if (!Number.isInteger(qty)) {
      throw new Error(`Row ${rowNo} of the Myntra sheet: Quantity "${cellText(qtyRaw)}" is not a whole number`);
    }
    if (qty <= 0) continue;

    const price = cellNumber(at('unitPrice'));
    const total = cellNumber(at('totalExTax'));
    if (Number.isFinite(price) && Number.isFinite(total) && Math.abs(qty * price - total) > TOTAL_TOLERANCE) {
      throw new Error(`Row ${rowNo} of the Myntra sheet does not add up: Quantity ${qty} × Unit Price ${price} is not the Total Cost ${total}`);
    }

    const barcode = cellText(at('barcode'));
    if (barcode) barcodes.add(barcode);
    invoiceDates.push(cellDate(at('invoiceDate')));
    slotDates.push(cellDate(at('slotDate')));

    if (bySku.has(sku)) bySku.get(sku).qty += qty;
    else bySku.set(sku, { item_code: sku, item_desc: '', qty });
  }

  if (barcodes.size === 0) throw new Error('Could not find the PO Barcode in the Myntra sheet');
  if (barcodes.size > 1) {
    throw new Error(`This Myntra file holds more than one PO (${[...barcodes].join(', ')}) — upload one PO per file`);
  }
  if (bySku.size === 0) throw new Error('No line items found in the Myntra sheet');

  const lines = [...bySku.values()].map((l, i) => ({ line_no: i + 1, ...l }));

  return {
    vendor_po_id: [...barcodes][0],
    po_date: earliest(invoiceDates),
    expected_delivery_date: null,
    po_expiry_date: null,
    appointment_date: earliest(slotDates),
    party_name: null,
    city: null,
    lines,
  };
}

module.exports = parseMyntra;
