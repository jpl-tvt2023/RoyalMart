// Articles that exist in the catalog but must not be offered as packaging
// demand.
//
// Corrugated is stored as an item_name under category = 'Packaging' rather than
// as a category of its own, so there is no data-driven way to filter it out --
// this exclusion is deliberately hardcoded. Keep it here as the single backend
// definition. The frontend twin lives in frontend/src/utils/packagingExclusions.js
// and must be kept in step.
//
// Prefix rather than exact match, so "Corrugated Box" and "Corrugated 5 Ply"
// are caught too.
const EXCLUDED_PACKAGING_ITEM_PREFIX = 'corrugated';

// SQL fragment for use against any table exposing an `item_name` column. The
// alias is passed in because callers query both packaging_raw_materials
// directly and joined as `prm`.
const excludedItemNameSql = (alias) =>
  `LOWER(${alias}.item_name) NOT LIKE '${EXCLUDED_PACKAGING_ITEM_PREFIX}%'`;

const isExcludedPackagingItem = (itemName) =>
  String(itemName || '').trim().toLowerCase().startsWith(EXCLUDED_PACKAGING_ITEM_PREFIX);

module.exports = {
  EXCLUDED_PACKAGING_ITEM_PREFIX,
  excludedItemNameSql,
  isExcludedPackagingItem,
};
