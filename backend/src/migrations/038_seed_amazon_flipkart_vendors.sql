-- Onboard two new marketplace PO vendors: "Amazon" (Amazon FBA shipment plans,
-- xlsx) and "Flipkart" (Flipkart Stock Transfer Invoices, PDF). Distinct from
-- the existing "Now"/"Minutes" quick-commerce vendors. The first-letter PO-ID
-- rule yields A001 / F001 (no collision with Z/S/B/N/M). has_parser is seeded to
-- 1 because both parsers ship in this change. vendors.controller reconciles
-- has_parser against the parser registry on any later edit. INSERT OR IGNORE
-- keeps this migration non-destructive and idempotent.
INSERT OR IGNORE INTO vendors (name, has_parser) VALUES ('Amazon', 1);
INSERT OR IGNORE INTO vendors (name, has_parser) VALUES ('Flipkart', 1);
