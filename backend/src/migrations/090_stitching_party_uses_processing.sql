-- The Processing party tag comes back, two days after 088 removed it.
--
-- 088 dropped it because a tag then meant "offer me when goods are SENT TO this
-- stage", and nothing is ever sent to Processing. The client has since
-- confirmed that a challan names its SENDER -- the party holding the goods at
-- the stage they leave -- and that every lot, Processing included, carries a
-- Stage Party picked from the parties who work at that stage. So a tag now
-- means "this party works at this stage", and a processing house has to be
-- taggable Processing again: it is the sender on every challan out of
-- Processing and the Stage Party on every Processing lot.
--
-- PARTY_USE_STAGES in stitching.service.js is now simply STAGES, and this CHECK
-- is its twin, so it lists all five.
--
-- No tags are restored or derived here. The client chose to re-tag parties by
-- hand in Purchase Config. The four Processing tags 088 deleted are in the
-- pre-087 backup JSON (as Processed) if anyone wants to know which they were.
--
-- Nothing references stitching_party_uses, so this is the same plain rebuild
-- 087 and 088 did -- create, copy, drop, rename, recreate the index.
--
-- No semicolons may appear in these comments -- migrate.js splits on them.
CREATE TABLE stitching_party_uses_new (
  party_id  INTEGER NOT NULL REFERENCES stitching_parties(id) ON DELETE CASCADE,
  use_stage TEXT NOT NULL CHECK (use_stage IN ('Processing','Stitching','Packing','Panchal','Third Party')),
  PRIMARY KEY (party_id, use_stage)
);

INSERT INTO stitching_party_uses_new (party_id, use_stage)
  SELECT party_id, use_stage FROM stitching_party_uses;

DROP TABLE stitching_party_uses;
ALTER TABLE stitching_party_uses_new RENAME TO stitching_party_uses;
CREATE INDEX IF NOT EXISTS idx_stitching_party_uses_stage ON stitching_party_uses(use_stage)
