-- The Processing party tag is dead, so it goes.
--
-- A party's use tags say which challan DESTINATIONS it is offered for. Before
-- migration 087 a party could be tagged Processed, meaning "offer me when Gray
-- fabric is sent for processing". 087 removed Gray and renamed the tag to
-- Processing -- but nothing is ever SENT to Processing any more. Fabric enters
-- the chain there on a PO receipt, so PARTY_USE_STAGES (derived from the
-- destination graph) no longer contains it, no challan dropdown asks for it,
-- and the tag only showed as a stray badge in Purchase Config.
--
-- On prod four parties carried it. Three also hold every real tag and lose
-- nothing. The fourth, a dyeing house tagged for Processing alone with no
-- challans, is left ACTIVE and becomes "Not tagged yet" -- the user's call, so
-- an admin can re-tag it if it ever takes other work.
--
-- No audit rows are written for the removed tags: this is a schema cleanup of
-- a value that stopped meaning anything, and the pre-087 backup JSON holds
-- the full tag history.
--
-- The CHECK is narrowed at the same time so the dead value cannot be written
-- back. Nothing references stitching_party_uses, so this is the same plain
-- rebuild 087 did -- create, copy, drop, rename, recreate the index.
--
-- No semicolons may appear in these comments -- migrate.js splits on them.
DELETE FROM stitching_party_uses WHERE use_stage = 'Processing';

CREATE TABLE stitching_party_uses_new (
  party_id  INTEGER NOT NULL REFERENCES stitching_parties(id) ON DELETE CASCADE,
  use_stage TEXT NOT NULL CHECK (use_stage IN ('Stitching','Packing','Panchal','Third Party')),
  PRIMARY KEY (party_id, use_stage)
);

INSERT INTO stitching_party_uses_new (party_id, use_stage)
  SELECT party_id, use_stage FROM stitching_party_uses;

DROP TABLE stitching_party_uses;
ALTER TABLE stitching_party_uses_new RENAME TO stitching_party_uses;
CREATE INDEX IF NOT EXISTS idx_stitching_party_uses_stage ON stitching_party_uses(use_stage)
