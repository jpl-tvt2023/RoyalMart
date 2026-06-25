-- Onboard two new marketplace PO vendors: "Now" (Amazon Now, PDF) and "Minutes"
-- (Flipkart Minutes, binary .xls). Registered under short names so the existing
-- first-letter PO-ID rule yields N001 / M001. has_parser is seeded to 1 because
-- both parsers ship in this change. vendors.controller reconciles has_parser
-- against the parser registry on any later edit. INSERT OR IGNORE keeps this
-- migration non-destructive and idempotent.
INSERT OR IGNORE INTO vendors (name, has_parser) VALUES ('Now', 1);
INSERT OR IGNORE INTO vendors (name, has_parser) VALUES ('Minutes', 1);
