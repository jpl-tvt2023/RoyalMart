-- Free-text note column for GRN page row-level comments
-- Always editable on the GRN page, not status-gated, no length cap at DB level

ALTER TABLE marketplace_pos ADD COLUMN note TEXT;
