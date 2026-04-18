CREATE TABLE users_new (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL
                  CHECK (role IN ('Admin','Owner','Office_POC','Purchase_Team','Stocks_Team','PO_Executive')),
  is_first_login INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO users_new (id, name, email, password_hash, role, is_first_login, created_at)
  SELECT id, name, email, password_hash, role, is_first_login, created_at FROM users;

DROP TABLE users;

ALTER TABLE users_new RENAME TO users
