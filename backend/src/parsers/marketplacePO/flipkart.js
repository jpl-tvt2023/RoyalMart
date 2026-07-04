const pdf = require('pdf-parse');
const { parseIndianDate } = require('./dates');

// Flipkart Stock Transfer Invoices glue the label and value together with no
// space after the colon, e.g. " Invoice Id:CIAA2UF270000025". Pull the value as
// everything after the first colon on the line that starts with the label.
function labelValue(lines, label) {
  const re = new RegExp('^' + label + '\\s*:\\s*(.+)$', 'i');
  for (const l of lines) {
    const m = l.match(re);
    if (m && m[1].trim()) return m[1].trim();
  }
  return null;
}

function extractCity(blockLines) {
  // City sits on a "<City> - <6-digit pincode>" line, e.g. "Howrah - 711316,".
  for (const l of blockLines) {
    const m = l.match(/^([A-Za-z][A-Za-z .]*?)\s*-\s*\d{6}\b/);
    if (m) return m[1].trim();
  }
  return null;
}

async function parseFlipkart(buffer) {
  const { text } = await pdf(buffer);
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  // Flipkart POs are keyed on the Consignment Note No — the identifier both
  // parties agree on for the shipment. The label sits glued to its value like the
  // others (e.g. "Consignment Note No:204536267").
  const vendor_po_id = labelValue(lines, 'Consignment Note No')
                    || labelValue(lines, 'Consignment Note Number')
                    || labelValue(lines, 'Consignment No');
  if (!vendor_po_id) throw new Error('Could not find Consignment Note No in Flipkart Stock Transfer PDF');

  const po_date = parseIndianDate(labelValue(lines, 'Invoice Date') || labelValue(lines, 'DC Date'));

  // The "Ship To" address block runs until the next section ("Shipped From").
  let party_name = null;
  let city = null;
  const shipIdx = lines.findIndex(l => /^Ship To$/i.test(l));
  if (shipIdx !== -1) {
    let end = lines.length;
    for (let i = shipIdx + 1; i < lines.length; i++) {
      if (/^Shipped From$/i.test(lines[i])) { end = i; break; }
    }
    const block = lines.slice(shipIdx + 1, end);
    if (block.length) party_name = block[0].replace(/,\s*$/, '').trim() || null;
    city = extractCity(block);
  }

  // Line items: each is a Description line, then "SKU: <sku>", then "HSN: <hsn>",
  // then a tail of glued numbers "<Qty><UnitPrice><BasePrice>..." (e.g.
  // "70.072.05040.05.0252.05292.0"). Qty is the integer before the first dot —
  // unambiguous since it is the first number and integers contain no dots.
  const result = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^TOTAL\b/i.test(lines[i])) break;
    const skuMatch = lines[i].match(/^SKU:\s*(.+)$/i);
    if (!skuMatch) continue;
    const item_code = skuMatch[1].trim();
    const item_desc = i > 0 ? lines[i - 1].trim() : '';

    // Find the numeric tail for this row (after the HSN line), before the next
    // SKU/TOTAL.
    let qty = null;
    for (let k = i + 1; k < lines.length; k++) {
      if (/^SKU:/i.test(lines[k]) || /^TOTAL\b/i.test(lines[k])) break;
      const m = lines[k].match(/^(\d+)\.\d/);
      if (m && /^[\d.]+$/.test(lines[k])) { qty = parseInt(m[1], 10); break; }
    }
    if (!item_code || !(qty > 0)) continue;
    result.push({ line_no: result.length + 1, item_code, item_desc, qty });
  }

  if (result.length === 0) throw new Error('No line items found in Flipkart Stock Transfer PDF');

  return {
    vendor_po_id,
    po_date,
    expected_delivery_date: null,
    po_expiry_date: null,
    party_name,
    city,
    lines: result,
  };
}

module.exports = parseFlipkart;
