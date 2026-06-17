const parseLegacy = require('./legacy');
const parseOtb = require('./otb');

const isValid = (r) => r && r.vendor_po_id && Array.isArray(r.lines) &&
  r.lines.some(l => Number(l.qty) > 0);

// Scootsy ships POs in two layouts (legacy + new "OTB"). The vendor is already
// known to be Scootsy here, so we detect the layout by trying each parser and
// taking the first that yields a PO number with at least one valid line. The
// per-row qty*unitBase≈taxable check inside each parser prevents false positives
// on the wrong layout, so the order of attempts is safe.
async function parseScootsy(buffer) {
  let legacyErr;
  try {
    const legacy = await parseLegacy(buffer);
    if (isValid(legacy)) return legacy;
  } catch (e) { legacyErr = e; }

  let otbErr;
  try {
    const otb = await parseOtb(buffer);
    if (isValid(otb)) return otb;
  } catch (e) { otbErr = e; }

  const detail = [legacyErr && `legacy: ${legacyErr.message}`, otbErr && `OTB: ${otbErr.message}`]
    .filter(Boolean).join('; ');
  throw new Error(
    `Could not parse Scootsy PO (tried legacy and OTB layouts)${detail ? ' — ' + detail : ''}`
  );
}

module.exports = parseScootsy;
