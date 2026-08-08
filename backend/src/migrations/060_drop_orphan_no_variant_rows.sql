-- Drop the leftover no-variant catalog rows that nothing uses.
--
-- Migration 049 created packaging_raw_materials with UNIQUE (category,
-- item_name) -- one row per item, no variant. Migration 056 rebuilt the table
-- with a variant column and copied every existing row across as variant = ''
-- (the canonical "no variant", stored as empty string rather than NULL because
-- SQLite treats NULLs as distinct inside a UNIQUE index). Every variant added
-- since is a separate row, so each pre-056 item still carries a base row
-- sitting beside its real variants, showing as "--" in the Variant column.
--
-- Those base rows are dead weight wherever the item has since gained real
-- variants and nothing points at the base row any more. A blank variant stays
-- legitimate for an item that genuinely has no variants, so this deletes only
-- the rows that satisfy all three conditions below.
--
-- The self-referencing EXISTS is safe despite reading the table being deleted
-- from: it only inspects rows with a non-blank variant, and this statement
-- never deletes one, so the predicate cannot shift mid-scan.
--
-- The two NOT EXISTS guards are what spare a base row that vendors or past POs
-- still reference -- on the live database that is Raw Material / Handkerchief,
-- which two vendors map to. Written as generic predicates rather than against
-- known ids so the file is correct on any database, and a no-op on a fresh one
-- where no variants exist yet.

DELETE FROM packaging_raw_materials
WHERE COALESCE(variant, '') = ''
  AND EXISTS     (SELECT 1 FROM packaging_raw_materials s
                  WHERE s.category = packaging_raw_materials.category
                    AND s.item_name = packaging_raw_materials.item_name
                    AND COALESCE(s.variant, '') <> '')
  AND NOT EXISTS (SELECT 1 FROM outbound_vendor_articles a
                  WHERE a.category = packaging_raw_materials.category
                    AND a.item_name = packaging_raw_materials.item_name
                    AND COALESCE(a.variant, '') = '')
  AND NOT EXISTS (SELECT 1 FROM outbound_po_lines l
                  WHERE l.category = packaging_raw_materials.category
                    AND l.item_name = packaging_raw_materials.item_name
                    AND COALESCE(l.variant, '') = '')
