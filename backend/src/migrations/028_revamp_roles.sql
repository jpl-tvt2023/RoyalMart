-- Revamp roles. Keep Admin, Owner, Office_POC, Warehouse_POC and add Employee.
-- Remove Purchase_Team and PO_Executive.
-- Access tiers: Admin/Owner get everything, Employee gets everything except the Admin section.
-- Office_POC and Warehouse_POC remain only as POC assignment-qualifier roles.
-- SQLite cannot ALTER a CHECK constraint in place, so the table is rebuilt
-- (same pattern as 019_rename_stocks_team_to_warehouse_poc.sql).

CREATE TABLE user_roles_new (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role    TEXT    NOT NULL CHECK (role IN ('Admin','Owner','Employee','Office_POC','Warehouse_POC')),
  PRIMARY KEY (user_id, role)
);

-- Carry over only the roles we keep (drops Purchase_Team / PO_Executive).
INSERT INTO user_roles_new (user_id, role)
SELECT user_id, role FROM user_roles
WHERE role IN ('Admin','Owner','Office_POC','Warehouse_POC');

-- Every user without Admin/Owner becomes an Employee.
INSERT OR IGNORE INTO user_roles_new (user_id, role)
SELECT u.id, 'Employee'
FROM users u
WHERE NOT EXISTS (
  SELECT 1 FROM user_roles r
  WHERE r.user_id = u.id AND r.role IN ('Admin','Owner')
);

DROP TABLE user_roles;
ALTER TABLE user_roles_new RENAME TO user_roles;
