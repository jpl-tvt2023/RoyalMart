-- Field-level audit trail.
-- 1) audit_logs.changes holds a JSON array of { field, old, new } for each mutation.
-- 2) updated_by / updated_at on every editable table so each page can show
--    "last updated by X at <time>". (marketplace_pos already has both.)

ALTER TABLE audit_logs ADD COLUMN changes TEXT;
-- Textual entity key (e.g. marketplace_pos.po_id 'B-001'), since entity_id is INTEGER.
ALTER TABLE audit_logs ADD COLUMN entity_ref TEXT;
CREATE INDEX IF NOT EXISTS idx_audit_entity_ref ON audit_logs(entity_type, entity_ref);

ALTER TABLE products              ADD COLUMN updated_by INTEGER REFERENCES users(id);
ALTER TABLE products              ADD COLUMN updated_at TEXT;

ALTER TABLE product_vendor_codes  ADD COLUMN updated_by INTEGER REFERENCES users(id);
ALTER TABLE product_vendor_codes  ADD COLUMN updated_at TEXT;

ALTER TABLE cities                ADD COLUMN updated_by INTEGER REFERENCES users(id);
ALTER TABLE cities                ADD COLUMN updated_at TEXT;

ALTER TABLE vendors               ADD COLUMN updated_by INTEGER REFERENCES users(id);
ALTER TABLE vendors               ADD COLUMN updated_at TEXT;

ALTER TABLE couriers              ADD COLUMN updated_by INTEGER REFERENCES users(id);
ALTER TABLE couriers              ADD COLUMN updated_at TEXT;

ALTER TABLE warehouse_teams       ADD COLUMN updated_by INTEGER REFERENCES users(id);
ALTER TABLE warehouse_teams       ADD COLUMN updated_at TEXT;

ALTER TABLE team_members          ADD COLUMN updated_by INTEGER REFERENCES users(id);
ALTER TABLE team_members          ADD COLUMN updated_at TEXT;

ALTER TABLE users                 ADD COLUMN updated_by INTEGER REFERENCES users(id);
ALTER TABLE users                 ADD COLUMN updated_at TEXT;

ALTER TABLE marketplace_po_lines  ADD COLUMN updated_by INTEGER REFERENCES users(id);
ALTER TABLE marketplace_po_lines  ADD COLUMN updated_at TEXT;
