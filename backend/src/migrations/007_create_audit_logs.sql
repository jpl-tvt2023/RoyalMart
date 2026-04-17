CREATE TABLE IF NOT EXISTS audit_logs (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action_type  VARCHAR(60) NOT NULL,
  description  TEXT,
  entity_type  VARCHAR(60),
  entity_id    INTEGER,
  timestamp    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_user   ON audit_logs(user_id);
