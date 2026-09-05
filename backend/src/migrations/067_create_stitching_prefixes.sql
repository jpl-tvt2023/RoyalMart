-- Configurable incoming-number prefixes, each declaring a processing stage.
--
-- The warehouse gate register writes an incoming number as a stage prefix plus
-- a free-text suffix (see migration 066 for why the suffix must stay TEXT). The
-- prefix is what says which stage the material was physically received at, and
-- therefore which tab of the Stitching page the lot belongs to. Several
-- prefixes may map to the same stage -- different registers, different sites --
-- so stage is a plain column rather than a unique key.
--
-- Shape follows the master-table convention established by companies (044) and
-- outbound_vendors (043): surrogate integer PK, NOCASE-unique business key,
-- is_active soft-delete, updated_by/updated_at audit pair. The extra `stage`
-- column is why the frontend models this on OutboundProductsTab rather than the
-- single-name MasterTab.
--
-- CHECK rather than a lookup table: the four stages are a fixed physical
-- process, not user data. Adding a fifth would be a schema change either way.
CREATE TABLE IF NOT EXISTS stitching_prefixes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  prefix     TEXT NOT NULL UNIQUE COLLATE NOCASE,
  stage      TEXT NOT NULL CHECK (stage IN ('Gray','Processed','Stitched','Packed')),
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_stitching_prefixes_stage ON stitching_prefixes(stage);

-- One starter prefix per stage so the feature is usable the moment it ships.
-- All four are renameable and deletable from Admin - Purchase Config, and more
-- can be added per stage. Nothing references them yet, so a fresh install that
-- wants entirely different codes can simply delete these.
INSERT INTO stitching_prefixes (prefix, stage) VALUES
  ('GRY', 'Gray'),
  ('PRC', 'Processed'),
  ('STC', 'Stitched'),
  ('PKD', 'Packed')
