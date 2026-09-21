// Who checked the goods in.
//
// Lived in OutboundPOs/receiptFields.js while the receipt form was the only
// thing that asked. It no longer asks — a receipt stamps whoever entered it —
// and the question moved to the two points in the stitching chain where it is
// a real second pair of eyes rather than the typist's own name: goods landing
// in our warehouse, and goods leaving the business. Shared from here because
// those live in a different feature folder.
//
// If a stored checker isn't in the live Warehouse_POC list (tagged before the
// rule existed, or since untagged), keep them selectable so the dropdown
// doesn't silently blank out a real recorded value.
export function checkerOptionsFor(checkers, checkedById, checkedByName) {
  const opts = (checkers || []).map(u => ({ value: u.id, label: u.name }));
  if (checkedById && !opts.some(o => String(o.value) === String(checkedById))) {
    opts.push({ value: checkedById, label: `${checkedByName || 'Unknown'} (not Warehouse POC)` });
  }
  return opts;
}
