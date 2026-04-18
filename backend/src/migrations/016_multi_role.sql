CREATE TABLE IF NOT EXISTS user_roles (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role    TEXT    NOT NULL CHECK (role IN ('Admin','Owner','Office_POC','Purchase_Team','Stocks_Team','PO_Executive')),
  PRIMARY KEY (user_id, role)
);
INSERT OR IGNORE INTO user_roles (user_id, role) SELECT id, role FROM users WHERE role IS NOT NULL;
ALTER TABLE users DROP COLUMN role;
