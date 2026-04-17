CREATE TABLE IF NOT EXISTS warehouse_teams (
  id         SERIAL PRIMARY KEY,
  team_name  VARCHAR(120) NOT NULL,
  lead_name  VARCHAR(120),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
