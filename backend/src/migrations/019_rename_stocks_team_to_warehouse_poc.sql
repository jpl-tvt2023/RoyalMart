-- Rename role 'Stocks_Team' to 'Warehouse_POC' across user_roles.
-- SQLite cannot ALTER a CHECK constraint in place, so the table is rebuilt.

CREATE TABLE user_roles_new (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role    TEXT    NOT NULL CHECK (role IN ('Admin','Owner','Office_POC','Purchase_Team','Warehouse_POC','PO_Executive')),
  PRIMARY KEY (user_id, role)
);

INSERT INTO user_roles_new (user_id, role)
SELECT user_id,
       CASE WHEN role = 'Stocks_Team' THEN 'Warehouse_POC' ELSE role END
FROM user_roles;

DROP TABLE user_roles;
ALTER TABLE user_roles_new RENAME TO user_roles;
