-- VENDOR PO PREFIX: each marketplace vendor names the letters its PO ids start
-- with, and Myntra is onboarded as MY.
--
-- Until now a PO id was the vendor's FIRST LETTER plus a three-digit serial
-- (Z001, B014, M007), and the serial was counted per vendor NAME. Two vendors
-- sharing a first letter therefore minted the same ids -- the first Myntra PO
-- came out as M001, which Minutes already owns, so the insert broke the
-- marketplace_pos primary key and the manual PO page showed "Internal server
-- error" (client, 2026-11-22). The inactive 'flipkart now' carried the same
-- latent clash with Flipkart, and a 'Myntra Now' is expected in a few months.
--
-- So the prefix becomes data on the vendor, set by an admin under
-- Configurations then Vendors: one to three letters A-Z, stored upper-case,
-- UNIQUE. The controller counts the serial per PREFIX (po_id GLOB prefix
-- followed by digits), which is collision-proof -- letters then digits split one
-- way only, so two different prefixes can never spell the same id. A vendor
-- with no prefix cannot take a PO until one is set, and a prefix is fixed once
-- the vendor has a PO, because ids already minted keep their letters.
--
-- BACKFILL. Every existing vendor keeps the letter it already uses, so no id or
-- number changes anywhere. Where two vendors share a letter, the letter goes to
-- the one that owns ids under it -- the one with POs whose id starts with that
-- letter -- and otherwise to the oldest row. The other stays NULL until an
-- admin picks a prefix. Expected: Minutes keeps M and Flipkart keeps F, while
-- Myntra and 'flipkart now' come out NULL. Only names starting with a letter
-- are backfilled, since a prefix is letters only.
--
-- RTV numbers follow the PO id rather than the vendor name from now on: the
-- letter part of the PO id, then R, then a serial per that prefix. For every
-- existing PO that is the same letter as before, so BR, MR, ZR and the rest
-- carry on unchanged, and Myntra returns start at MYR001.
--
-- MYNTRA. Added by hand through Configurations, so its stored spelling may
-- differ in case from the parser registry key, which is case-sensitive. Its
-- name is normalised to exactly Myntra while it has no POs (a PO stores the
-- vendor's name as text, so a vendor with POs is never renamed here). The row
-- is inserted when absent (a fresh or test database), then given MY and
-- has_parser = 1 -- the parser ships in this change, and has_parser is
-- otherwise only recomputed when an admin saves the vendor.
--
-- Additive: a nullable column and an index. Old code never reads the column,
-- and the new code does, so this file must be applied BEFORE that code is
-- deployed -- the same order as 095.
--
-- No semicolons may appear in these comments -- migrate.js splits on them.

ALTER TABLE vendors ADD COLUMN po_prefix TEXT;

UPDATE vendors
   SET po_prefix = UPPER(SUBSTR(name, 1, 1))
 WHERE UPPER(SUBSTR(name, 1, 1)) BETWEEN 'A' AND 'Z'
   AND id = (
     SELECT v2.id
       FROM vendors v2
      WHERE UPPER(SUBSTR(v2.name, 1, 1)) = UPPER(SUBSTR(vendors.name, 1, 1))
      ORDER BY EXISTS (
                 SELECT 1 FROM marketplace_pos p
                  WHERE p.vendor = v2.name
                    AND p.po_id GLOB UPPER(SUBSTR(v2.name, 1, 1)) || '[0-9]*'
               ) DESC,
               v2.id ASC
      LIMIT 1
   );

CREATE UNIQUE INDEX IF NOT EXISTS idx_vendors_po_prefix ON vendors(po_prefix);

UPDATE vendors
   SET name = 'Myntra'
 WHERE name = 'Myntra'
   AND name <> 'Myntra' COLLATE BINARY
   AND NOT EXISTS (SELECT 1 FROM marketplace_pos p WHERE p.vendor = vendors.name);

INSERT OR IGNORE INTO vendors (name, has_parser) VALUES ('Myntra', 1);

UPDATE vendors
   SET po_prefix = 'MY', has_parser = 1
 WHERE name = 'Myntra' COLLATE BINARY
   AND po_prefix IS NULL
