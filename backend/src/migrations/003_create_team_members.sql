CREATE TABLE IF NOT EXISTS team_members (
  id          SERIAL PRIMARY KEY,
  team_id     INTEGER NOT NULL REFERENCES warehouse_teams(id) ON DELETE CASCADE,
  member_name VARCHAR(120) NOT NULL
);
