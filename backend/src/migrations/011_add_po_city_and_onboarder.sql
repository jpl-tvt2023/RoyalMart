ALTER TABLE marketplace_pos ADD COLUMN city TEXT;
ALTER TABLE marketplace_pos ADD COLUMN onboarded_by INTEGER REFERENCES users(id);
UPDATE marketplace_pos SET onboarded_by = created_by WHERE onboarded_by IS NULL;
