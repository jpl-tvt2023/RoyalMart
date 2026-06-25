const pdf = require('pdf-parse');
const { parseIndianDate } = require('./dates');

function pad2(n) { return String(n).padStart(2, '0'); }

function titleCaseCity(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim();
}

// Amazon Now mixes US (MM/DD/YYYY) and Indian (DD/MM/YYYY) date formats within
// the same PDF (e.g. "Ordered On 06/09/2026" vs "Ship window 9/6/2026 -
// 29/6/2026"). Disambiguate by value when possible, else fall back to `prefer`.
function parseFlexDate(raw, prefer = 'us') {
  if (!raw) return null;
  const m = String(raw).match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (!m) return parseIndianDate(raw);
  const a = Number(m[1]), b = Number(m[2]), y = Number(m[3]);
  let day, mon;
  if (a > 12) { day = a; mon = b; }          // first part can only be a day
  else if (b > 12) { mon = a; day = b; }     // second part can only be a day
  else if (prefer === 'indian') { day = a; mon = b; }
  else { mon = a; day = b; }
  if (mon < 1 || mon > 12 || day < 1 || day > 31) return null;
  return `${y}-${pad2(mon)}-${pad2(day)}`;
}

// Find the value for a label that sits on its own line with the value on the
// next non-empty line (Amazon's two-column layout flattens to this), or inline
// as "Label: value".
function labelValue(lines, label) {
  const re = new RegExp('^' + label + '\\s*:?\\s*(.*)$', 'i');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (m) {
      const inline = m[1].trim();
      if (inline) return inline;
      for (let k = i + 1; k < lines.length; k++) {
        if (lines[k].trim()) return lines[k].trim();
      }
    }
  }
  return null;
}

const ASIN_LINE = /^([A-Z0-9]{10})SKU:/;

// The per-row tail glues the requested/accepted/asn/received/outstanding
// quantities onto the unit cost, e.g. "...06/18/2026393939039147.95 INR5770.05
// INR" (qty digits "393939039" + unit 147.95 + total 5770.05). The boundary
// between the qty digits and the unit cost's integer part is ambiguous, so we
// recover qty as round(total / unit) by trying each possible unit suffix and
// keeping the one that yields a whole number — mirrors blinkit.js.
function recoverQty(qtyUnitGlued, totalCost) {
  const m = qtyUnitGlued.match(/^(\d+)\.(\d+)$/);
  if (!m) return null;
  const intDigits = m[1];
  const dec = m[2];
  for (let take = 1; take < intDigits.length; take++) {
    const unit = parseFloat(intDigits.slice(intDigits.length - take) + '.' + dec);
    if (!(unit > 0)) continue;
    const q = totalCost / unit;
    const qr = Math.round(q);
    if (qr > 0 && Math.abs(q - qr) < 0.01) return qr;
  }
  return null;
}

async function parseNow(buffer) {
  const { text } = await pdf(buffer);
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  const vendor_po_id = labelValue(lines, 'PO');
  if (!vendor_po_id) throw new Error('Could not find PO number in Amazon Now PDF');

  const po_date = parseFlexDate(labelValue(lines, 'Ordered On'), 'us');

  // No explicit expiry field — use the end ("to") date of the ship window.
  let po_expiry_date = null;
  const shipWindow = labelValue(lines, 'Ship window');
  if (shipWindow) {
    const parts = shipWindow.split(/[-–]/).map(s => s.trim()).filter(Boolean);
    po_expiry_date = parseFlexDate(parts[parts.length - 1], 'indian');
  }

  const party_name = labelValue(lines, 'Purchasing entity');

  let city = null;
  const shipTo = labelValue(lines, 'Ship to location'); // e.g. "HHY7 - HYDERABAD, TELANGANA"
  if (shipTo) {
    const after = shipTo.split(/[-–]/).slice(1).join('-'); // drop the FC code prefix
    const cityRaw = (after || shipTo).split(',')[0];
    city = titleCaseCity(cityRaw) || null;
  }

  // Split the line-item region into per-ASIN blocks, then read the tail of each.
  const startIdx = lines.findIndex(l => ASIN_LINE.test(l));
  const blocks = [];
  if (startIdx !== -1) {
    let blockStart = startIdx;
    for (let i = startIdx + 1; i <= lines.length; i++) {
      if (i === lines.length || ASIN_LINE.test(lines[i])) {
        blocks.push(lines.slice(blockStart, i));
        blockStart = i;
      }
    }
  }

  const result = [];
  for (const block of blocks) {
    const asin = block[0].match(ASIN_LINE)[1];
    // Concatenate raw (no separator) so the data tail split across two lines
    // rejoins into "<date><qtyDigits>.<dd> INR<total> INR".
    const blob = block.join('');
    const tail = blob.match(/(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4})(\d+\.\d+)\s*INR\s*(\d+(?:\.\d+)?)\s*INR/);
    if (!tail) continue; // page-break/header fragment without a real data row
    const qty = recoverQty(tail[2], parseFloat(tail[3]));
    if (!(qty > 0)) continue;

    // Description = everything between the ASIN/SKU label and the delivery
    // window block (seller SKU + model + title), best-effort and human-readable.
    const descLines = [];
    for (let k = 1; k < block.length; k++) {
      if (/^Delivery$/i.test(block[k]) || /^Delivery window/i.test(block[k])) break;
      descLines.push(block[k]);
    }
    const item_desc = descLines.join(' ').replace(/\s+/g, ' ').replace(/^SKU:\s*/i, '').trim();

    result.push({ line_no: result.length + 1, item_code: asin, item_desc, qty });
  }

  if (result.length === 0) throw new Error('No line items found in Amazon Now PDF');

  return {
    vendor_po_id,
    po_date,
    expected_delivery_date: null,
    po_expiry_date,
    party_name,
    city,
    lines: result,
  };
}

module.exports = parseNow;
