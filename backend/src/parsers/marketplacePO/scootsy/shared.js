// Helpers shared by the Scootsy sub-parsers (legacy + OTB layouts).

// Scootsy POs render labels and values either on the same line ("PO No : X")
// or on separate lines:
//   "PO No :"
//   "GCAPO52697"
function fieldByLabel(lines, label) {
  // Allow any whitespace (incl. tabs, which pdf-parse emits between words in the
  // OTB layout) wherever the label has a space: "PO No" matches "PO\tNo".
  const lbl = label.replace(/\s+/g, '\\s+');
  for (let i = 0; i < lines.length; i++) {
    if (new RegExp('^\\s*' + lbl + '\\s*:?\\s*$', 'i').test(lines[i])) {
      for (let k = i + 1; k < lines.length; k++) {
        if (lines[k].trim()) return lines[k].trim();
      }
    }
    const same = lines[i].match(new RegExp('^\\s*' + lbl + '\\s*:\\s*(.+)$', 'i'));
    if (same && same[1].trim()) return same[1].trim();
  }
  return null;
}

const NUMERIC_LINE_RE = /^[\d.]+$/;

module.exports = { fieldByLabel, NUMERIC_LINE_RE };
