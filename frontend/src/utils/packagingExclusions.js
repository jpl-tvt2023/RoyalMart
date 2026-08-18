// Packaging articles that must not be offered as a NEW selection.
//
// Corrugated is stored as an item_name under category = 'Packaging' rather than
// as a category of its own, so there is no data-driven way to filter it out —
// this exclusion is deliberately hardcoded. The backend twin lives in
// backend/src/services/packagingExclusions.js and must be kept in step.
//
// Prefix rather than exact match, so "Corrugated Box" and "Corrugated 5 Ply"
// are caught too.
const EXCLUDED_PACKAGING_ITEM_PREFIX = 'corrugated';

export const isExcludedPackagingItem = (itemName) =>
  String(itemName || '').trim().toLowerCase().startsWith(EXCLUDED_PACKAGING_ITEM_PREFIX);
