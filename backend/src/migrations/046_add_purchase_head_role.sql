-- Add Purchase_Head, an assignment-qualifier tag (like Office_POC/Warehouse_POC)
-- gating the outbound PO "Approved By" picker. SQLite can't ALTER a CHECK
-- constraint in place, so the table is rebuilt (same pattern as 028_revamp_roles.sql).

CREATE TABLE user_roles_new (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role    TEXT    NOT NULL CHECK (role IN ('Admin','Owner','Employee','Office_POC','Warehouse_POC','Purchase_Head')),
  PRIMARY KEY (user_id, role)
);

INSERT INTO user_roles_new (user_id, role)
SELECT user_id, role FROM user_roles;

DROP TABLE user_roles;
ALTER TABLE user_roles_new RENAME TO user_roles;
