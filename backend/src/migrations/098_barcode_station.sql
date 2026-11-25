-- BARCODE STATION. A page warehouse staff reach WITHOUT a portal login, where
-- each delivery of packaging stock is written down (vendor, article, pack size,
-- floor, how many labels) and given one random 8-digit key per label, which the
-- portal prints as a Code128 sticker. Phase 2 will scan those stickers daily to
-- tell whether each pack is still in the warehouse or went out on a PO -- this
-- file is phase 1 and is shaped so phase 2 only adds a scans table.
--
-- The model, in the order this file builds it:
--
-- 1. floors -- a name-only master in the companies shape (id, name, is_active).
--    Deliberately NOT tied to the warehouses master (096): the client wants
--    the two kept apart, and a floor is only ever a label on a sticker whose
--    caption already says "Panchal Floor". Seeded with dummy rows the client
--    will rename. Delete means deactivate.
--
-- 2. label_batches -- one row per entry the operator fills in. Vendor is an
--    outbound vendor, Article a packaging_raw_materials row that vendor is
--    mapped to. This is the FIRST table to reference packaging_raw_materials,
--    so a future rebuild of that table needs the 081 detach-and-reattach, and
--    the catalog delete paths now refuse an article a batch uses.
--    generated_at / generated_by are NULL on a draft. Generating sets both, in
--    the same transaction that writes every key, so a batch has all its keys or
--    none. A generated batch is never edited or deleted -- its stickers may
--    already be on boxes. entered_by / generated_by are the operator's typed
--    name, plain text, because nobody signs in at the station. The audit row
--    carries the barcode-station system user (item 5) plus that name.
--
-- 3. label_keys -- one row per sticker. label_key is the 8-digit number the
--    barcode encodes, random (never a counter, by the client's choice), and
--    the PRIMARY KEY, so a key can exist once in the whole system and a scan
--    in phase 2 resolves with a single lookup. batch_id + label_no (1..N) tie
--    every key back to the entry it was printed for. The range starts at
--    10000000 so every key is exactly 8 digits with no leading zero. Keys are
--    never reused: rows are never deleted, and a generated batch cannot be.
--
-- 4. barcode_station_settings -- a single row (id = 1). pin_hash is the
--    bcrypt hash of the shared numeric PIN (4 to 8 digits), NULL until an Admin
--    sets one, and while NULL the station refuses every sign-in. pin_version is
--    baked into each device's station token and compared on every request, so
--    changing the PIN, or "sign out all devices", logs every device out at
--    once. failed_attempts / locked_until are the brute-force guard, kept in the
--    database because the rate limiter is per serverless instance: every 10th
--    wrong PIN locks NEW sign-ins for 15 minutes, doubling each time up to a
--    day, and only a correct PIN or an Admin resets it. label_width_mm /
--    label_height_mm are the sticker size the print sheet is laid out at --
--    the client said "2x6", read as 6 x 2 inches landscape, so 152 x 51.
--
-- 5. The barcode-station system user, the 094 tally-sync pattern: no password
--    can match its hash and auth.controller.js refuses its username, so it is
--    an identity for audit_logs, never a login.
--
-- Additive only -- old code never reads any of it, so this file can be applied
-- ahead of the deploy.
--
-- No semicolons may appear in these comments -- migrate.js splits on them.

CREATE TABLE IF NOT EXISTS floors (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO floors (name) VALUES ('Ground Floor'), ('1st Floor'), ('2nd Floor');

CREATE TABLE IF NOT EXISTS label_batches (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  outbound_vendor_id INTEGER NOT NULL REFERENCES outbound_vendors(id),
  article_id         INTEGER NOT NULL REFERENCES packaging_raw_materials(id),
  floor_id           INTEGER NOT NULL REFERENCES floors(id),
  pack_size          INTEGER NOT NULL CHECK (pack_size > 0),
  label_count        INTEGER NOT NULL CHECK (label_count > 0),
  entered_by         TEXT NOT NULL,
  generated_at       TEXT,
  generated_by       TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at         TEXT,
  CHECK ((generated_at IS NULL) = (generated_by IS NULL)),
  CHECK (generated_at IS NULL OR deleted_at IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_label_batches_vendor  ON label_batches(outbound_vendor_id);
CREATE INDEX IF NOT EXISTS idx_label_batches_article ON label_batches(article_id);
CREATE INDEX IF NOT EXISTS idx_label_batches_floor   ON label_batches(floor_id);

CREATE TABLE IF NOT EXISTS label_keys (
  label_key INTEGER PRIMARY KEY CHECK (label_key BETWEEN 10000000 AND 99999999),
  batch_id  INTEGER NOT NULL REFERENCES label_batches(id),
  label_no  INTEGER NOT NULL CHECK (label_no > 0),
  UNIQUE (batch_id, label_no)
);

CREATE TABLE IF NOT EXISTS barcode_station_settings (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  pin_hash        TEXT,
  pin_version     INTEGER NOT NULL DEFAULT 0,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until    TEXT,
  label_width_mm  INTEGER NOT NULL DEFAULT 152 CHECK (label_width_mm BETWEEN 20 AND 300),
  label_height_mm INTEGER NOT NULL DEFAULT 51 CHECK (label_height_mm BETWEEN 10 AND 300),
  updated_by      INTEGER REFERENCES users(id),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO barcode_station_settings (id) VALUES (1);

INSERT OR IGNORE INTO users (name, email, username, password_hash, is_first_login)
VALUES ('Barcode Station', 'barcode-station@system.invalid', 'barcode-station', '!system-account-no-login', 0);

INSERT OR IGNORE INTO user_roles (user_id, role)
SELECT id, 'Employee' FROM users WHERE username = 'barcode-station'
