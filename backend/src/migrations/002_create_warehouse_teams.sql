CREATE TABLE IF NOT EXISTS warehouse_teams (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  team_name  TEXT NOT NULL,
  lead_name  TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)
