-- SKU requirements gain two more sections alongside the existing raw-product
-- requirements (product_requirements): what packaging articles and what
-- barcode article this SKU consumes per unit. Both reference the same master
-- article catalog (packaging_raw_materials) that /packaging-items manages --
-- packaging rows point at articles under category = 'Packaging', barcode rows
-- at articles under category = 'Barcode'. Kept as two tables (not one filtered
-- by category) so each can carry its own "at least one row" validation without
-- the controller having to partition a merged array by category.
CREATE TABLE IF NOT EXISTS product_packaging_requirements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  packaging_raw_material_id INTEGER NOT NULL REFERENCES packaging_raw_materials(id),
  qty INTEGER NOT NULL DEFAULT 0,
  UNIQUE (product_id, packaging_raw_material_id)
);
CREATE INDEX IF NOT EXISTS idx_product_packaging_requirements_product ON product_packaging_requirements(product_id);

CREATE TABLE IF NOT EXISTS product_barcode_requirements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  packaging_raw_material_id INTEGER NOT NULL REFERENCES packaging_raw_materials(id),
  qty INTEGER NOT NULL DEFAULT 0,
  UNIQUE (product_id, packaging_raw_material_id)
);
CREATE INDEX IF NOT EXISTS idx_product_barcode_requirements_product ON product_barcode_requirements(product_id)
