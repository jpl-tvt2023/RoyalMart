-- The party master the stitching chain has been waiting for.
--
-- Migration 069 left this explicitly open: "party_name is free text, not a FK.
-- The processing houses are not necessarily outbound vendors, and the user has
-- said a party master may come later -- when it does, add party_id and backfill
-- against this column." This is that master. The party_id column and its
-- backfill land in 082, which rebuilds stitching_entries anyway.
--
-- WHY A SEPARATE MASTER rather than reusing outbound_vendors. An outbound vendor
-- sells us raw material against a PO. A stitching party does job work on
-- material we already own, or buys finished goods off us. The two lists overlap
-- by accident, not by rule, and listParties() unioning them was a stand-in for
-- exactly this table.
--
-- WHAT A "USE" IS. Each party is tagged with the DESTINATIONS it may serve, so
-- the challan form can offer only parties that can legitimately do the job being
-- dispatched. Gray is absent from the list on purpose: nothing is ever sent TO
-- Gray. Material enters the chain there on an outbound PO receipt, so a Gray
-- party would be a party nobody could ever pick.
--
-- A join table rather than a delimited column, matching user_roles. It keeps the
-- CHECK enforceable per row and makes "which parties can take stitching work" a
-- plain WHERE instead of a LIKE over a packed string.
--
-- Shape follows the master-table convention set by companies (044),
-- outbound_vendors (043) and stitching_prefixes (067): surrogate integer PK,
-- NOCASE-unique business key, is_active soft-delete, updated_by/updated_at.
CREATE TABLE IF NOT EXISTS stitching_parties (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS stitching_party_uses (
  party_id  INTEGER NOT NULL REFERENCES stitching_parties(id) ON DELETE CASCADE,
  use_stage TEXT NOT NULL CHECK (use_stage IN ('Processed','Stitched','Packed','Panchal','Third Party')),
  PRIMARY KEY (party_id, use_stage)
);

CREATE INDEX IF NOT EXISTS idx_stitching_party_uses_stage ON stitching_party_uses(use_stage);

-- Backfill every name already typed into a live challan, so existing history
-- keeps resolving to a real master row and nobody has to retype what is already
-- there. Deliberately WITHOUT use tags: which jobs each party may take is a
-- judgement only the admin can make, and a wrong guess here would silently widen
-- the dropdowns. They arrive untagged, and Admin - Purchase Config ticks them.
--
-- OR IGNORE because DISTINCT is case-sensitive while the unique index is NOCASE,
-- so "Sharma" and "sharma" both reach this insert and only the first may land.
INSERT OR IGNORE INTO stitching_parties (name)
  SELECT DISTINCT TRIM(party_name) FROM stitching_entries
   WHERE deleted_at IS NULL AND party_name IS NOT NULL AND TRIM(party_name) <> ''
