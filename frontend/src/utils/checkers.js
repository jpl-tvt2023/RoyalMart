// Who checked the goods in -- a Warehouse POC.
//
// Asked on a challan into Panchal or Third Party, and on an outbound PO
// receipt that takes one (receiptTakesChecker): every receipt that never
// reaches the Stitching page, and a stitching receipt at Panchal or Third
// Party. Shared from here because those live in different feature folders.

// How a stored checker who is not (or no longer) a Warehouse POC is labelled --
// in the dropdown and in the receipts table alike. Receipts entered from
// 21 Sep 2026 until Checked By was asked again hold whoever typed them.
export const NOT_POC_SUFFIX = ' (not Warehouse POC)';

// If a stored checker isn't in the live Warehouse_POC list (tagged before the
// rule existed, since untagged, or a typist recorded in their place), keep them
// selectable so the dropdown doesn't silently blank out a recorded value.
export function checkerOptionsFor(checkers, checkedById, checkedByName) {
  const opts = (checkers || []).map(u => ({ value: u.id, label: u.name }));
  if (checkedById && !opts.some(o => String(o.value) === String(checkedById))) {
    opts.push({ value: checkedById, label: `${checkedByName || 'Unknown'}${NOT_POC_SUFFIX}` });
  }
  return opts;
}
