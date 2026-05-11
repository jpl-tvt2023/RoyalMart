-- Drop legacy modules that are no longer part of the app: Inventory,
-- Restock (Supplier POs), Packaging Materials. The Products / SKU table
-- is intentionally retained because vendor mappings still reference it.

DROP TABLE IF EXISTS supplier_po_lines;
DROP TABLE IF EXISTS supplier_pos;
DROP TABLE IF EXISTS inventory;
DROP TABLE IF EXISTS packaging_materials;
