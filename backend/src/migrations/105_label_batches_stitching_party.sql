-- STITCHING / PACKING PARTY ON A LABEL ENTRY (client, 2026-11-27).
--
-- A Barcode Station entry may now name the stitching house the goods came
-- from or were packed by -- an OPTIONAL field beside Vendor Name. Its values
-- come from the ROMS stitching party master (Purchase Config -> Stitching
-- Parties): the ACTIVE parties ticked Stitching or Packing. Ticking either tag
-- puts a party in the list. The client also wants it PRINTED on the sticker,
-- as a "Stitching/Packing" line under Vendor Name, when it is set.
--
-- Stored by id, like the vendor and the article, so a rename shows
-- everywhere. Nullable because the field is optional. No index -- the table is
-- small -- so a plain DROP COLUMN stays possible should it ever go. Parties are
-- only ever deactivated (is_active = 0), never deleted, so the reference
-- cannot dangle. The picked party is re-checked (active, still tagged
-- Stitching or Packing) on save and again at Generate, as the vendor is.
--
-- Additive: old code never reads it, so this file goes ahead of the deploy,
-- together with 104. 106 (dropping label_batches.floor_id) goes AFTER the
-- deploy -- apply these two with  node src/migrations/migrate.js --until=105
--
-- No semicolons may appear in these comments -- migrate.js splits on them.

ALTER TABLE label_batches
  ADD COLUMN stitching_party_id INTEGER REFERENCES stitching_parties(id)
