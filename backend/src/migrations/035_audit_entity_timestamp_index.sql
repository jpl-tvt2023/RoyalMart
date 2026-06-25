-- Support efficient retention purges and time-bounded history reads by entity type
-- (e.g. the 31-day user account history window).
CREATE INDEX IF NOT EXISTS idx_audit_entity_ts ON audit_logs(entity_type, timestamp);
