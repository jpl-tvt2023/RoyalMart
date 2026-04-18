ALTER TABLE marketplace_pos ADD COLUMN updated_by INTEGER REFERENCES users(id);
UPDATE marketplace_pos SET updated_by = created_by WHERE updated_by IS NULL;
