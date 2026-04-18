ALTER TABLE marketplace_pos ADD COLUMN status TEXT NOT NULL DEFAULT 'Open' CHECK (status IN ('Open','In Progress','Completed','Cancelled'));
