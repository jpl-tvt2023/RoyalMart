const parseLegacy = require('./legacy');
const parseOtb = require('./otb');

const isValid = (r) => r && r.vendor_po_id && Array.isArray(r.lines) &&
  r.lines.some(l => Number(l.qty) > 0);

// Scootsy ships POs in two layouts (legacy + new "OTB"). The vendor is already
// known to be Scootsy here, so we run both parsers and keep whichever recovered
// MORE line items. Picking the first parser that yields any valid line is not
// safe: the wrong layout can spuriously match a stray row (e.g. legacy's fixed
// 3-decimal regex matching one OTB row by chance), which would short-circuit the
// correct layout and drop the rest of the table. The right layout recovers the
// full table, so it wins on line count. Ties keep legacy (evaluated first).
async function parseScootsy(buffer) {
  const candidates = [];
  let legacyErr, otbErr;

  try {
    const legacy = await parseLegacy(buffer);
    if (isValid(legacy)) candidates.push(legacy);
  } catch (e) { legacyErr = e; }

  try {
    const otb = await parseOtb(buffer);
    if (isValid(otb)) candidates.push(otb);
  } catch (e) { otbErr = e; }

  if (candidates.length) {
    // Stable sort: on equal line counts the first-pushed (legacy) is retained.
    candidates.sort((a, b) => b.lines.length - a.lines.length);
    return candidates[0];
  }

  const detail = [legacyErr && `legacy: ${legacyErr.message}`, otbErr && `OTB: ${otbErr.message}`]
    .filter(Boolean).join('; ');
  throw new Error(
    `Could not parse Scootsy PO (tried legacy and OTB layouts)${detail ? ' — ' + detail : ''}`
  );
}

module.exports = parseScootsy;
