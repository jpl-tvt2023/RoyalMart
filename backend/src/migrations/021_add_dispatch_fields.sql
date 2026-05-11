-- Dispatch tracking on marketplace_pos plus a small courier master.
-- Tracking IDs may repeat within the same vendor but must NOT be shared
-- across different vendors; that rule is enforced in the application layer
-- because SQLite cannot express it as a simple table constraint.

CREATE TABLE IF NOT EXISTS couriers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO couriers (name) VALUES
  ('Delhivery'),
  ('Bluedart'),
  ('DTDC'),
  ('Ekart'),
  ('XpressBees'),
  ('Shadowfax');

ALTER TABLE marketplace_pos ADD COLUMN courier_id  INTEGER REFERENCES couriers(id);
ALTER TABLE marketplace_pos ADD COLUMN tracking_id TEXT;

CREATE INDEX IF NOT EXISTS idx_marketplace_pos_tracking_id
  ON marketplace_pos(tracking_id) WHERE tracking_id IS NOT NULL;
