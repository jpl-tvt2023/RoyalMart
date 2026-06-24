-- Remove the Team Management feature. The warehouse_teams and team_members tables
-- were never wired into any workflow (members were free-text names not linked to
-- users, and POC assignments reference users directly). Drop the child table first
-- to satisfy the foreign key.
DROP TABLE IF EXISTS team_members;
DROP TABLE IF EXISTS warehouse_teams;
