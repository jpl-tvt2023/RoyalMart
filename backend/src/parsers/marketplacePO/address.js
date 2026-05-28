// Heuristic extraction of the Ship-To party name from a PDF-parsed line array.
// Finds the first non-empty, non-stop-keyword line after a "Ship To" / "Shipping
// Address" / "Consignee" header. Each marketplace prints the address differently,
// so this is best-effort — returns null on no match and the caller treats null
// as "not extracted".

const HEADER_RE = /^(ship\s*to|shipping\s+address|consignee|deliver(?:y)?\s+to|delivery\s+address)\s*[:.-]?\s*$/i;
const STOP_RE   = /^(bill\s*to|billing\s+address|gst(in)?\b|pan\b|state\s*code|invoice|po\s*no|r\.?o\.?\s*number|tax|cin\b)/i;

function extractShipToParty(flatLines) {
  if (!Array.isArray(flatLines)) return null;
  for (let i = 0; i < flatLines.length; i++) {
    if (!HEADER_RE.test(flatLines[i])) continue;
    for (let k = i + 1; k < flatLines.length; k++) {
      const v = (flatLines[k] || '').trim();
      if (!v) continue;
      if (STOP_RE.test(v)) break;
      return v;
    }
  }
  return null;
}

module.exports = { extractShipToParty };
