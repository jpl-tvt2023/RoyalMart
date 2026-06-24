// Extraction of the buyer (party) legal entity from a PDF-parsed line array.
// Marketplace layouts vary and pdf-parse often glues the "Billing Address Shipping
// Address" header onto one line and labels onto their own lines, so callers prefer
// a vendor-specific anchor (e.g. companyAfterShipping) and fall back to the generic
// heuristic here. Party Name = the buyer legal entity (owner decision).

const STOP_RE = /^(bill\s*to|billing\s+address|gst(in)?\b|pan\b|state\s*code|invoice|po\s*no|r\.?o\.?\s*number|tax\b|cin\b|contact\b|postal\s*code|seller\b|address\s*:?\s*$)/i;

// Normalise a candidate line into a clean company name, or null if it's a label,
// a stop keyword, or not company-like.
function cleanCompany(line) {
  let v = (line || '').replace(/\s+/g, ' ').trim();   // collapse tabs/runs (OTB uses tabs)
  if (!v) return null;
  v = v.replace(/^address\s*:\s*/i, '').trim();   // drop an inline "Address:" prefix
  if (!v) return null;
  if (STOP_RE.test(v)) return null;
  if (!/[A-Za-z]{3,}/.test(v)) return null;        // must look like a name
  v = v.replace(/\s*\(.*$/, '').trim();            // drop "(Formerly known as …)" etc.
  return v || null;
}

// First company-like line after a "Shipping Address" header. Handles the combined
// "Billing Address Shipping Address" line pdf-parse emits, and skips label/stop
// lines such as "Address:". Used by Scootsy and Zepto layouts.
function companyAfterShipping(flatLines) {
  if (!Array.isArray(flatLines)) return null;
  const idx = flatLines.findIndex(l => /shipping\s+address/i.test(l));
  if (idx === -1) return null;
  for (let k = idx + 1; k < flatLines.length; k++) {
    const v = cleanCompany(flatLines[k]);
    if (v) return v;
  }
  return null;
}

// Generic best-effort fallback: find a Ship-To / Consignee / Delivered-To /
// Shipping-Address header, then the first company-like line after it (or inline
// after a colon on the same line).
const HEADER_RE = /(ship\s*to|shipping\s+address|consignee|deliver(?:ed|y)?\s+to|delivery\s+address)/i;
function extractShipToParty(flatLines) {
  if (!Array.isArray(flatLines)) return null;
  for (let i = 0; i < flatLines.length; i++) {
    if (!HEADER_RE.test(flatLines[i])) continue;
    const inline = cleanCompany(flatLines[i].split(':').slice(1).join(':'));
    if (inline) return inline;
    for (let k = i + 1; k < flatLines.length; k++) {
      const v = cleanCompany(flatLines[k]);
      if (v) return v;
    }
  }
  return null;
}

module.exports = { extractShipToParty, companyAfterShipping, cleanCompany };
