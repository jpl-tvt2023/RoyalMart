const pool = require('../config/db');
const { logAction } = require('../services/auditLog.service');

async function list(req, res, next) {
  try {
    const { rows: teams } = await pool.query('SELECT * FROM warehouse_teams ORDER BY created_at DESC');
    const { rows: members } = await pool.query('SELECT * FROM team_members ORDER BY id');
    const result = teams.map(t => ({
      ...t,
      members: members.filter(m => m.team_id === t.id),
    }));
    res.json(result);
  } catch (err) { next(err); }
}

async function create(req, res, next) {
  try {
    const { team_name, lead_name } = req.body;
    if (!team_name) return res.status(400).json({ message: 'team_name is required' });
    const { rows } = await pool.query(
      'INSERT INTO warehouse_teams (team_name, lead_name) VALUES ($1,$2) RETURNING *',
      [team_name, lead_name || null]
    );
    await logAction({ userId: req.user.id, actionType: 'TEAM_CREATE', description: `Created team: ${team_name}`, entityType: 'warehouse_team', entityId: rows[0].id });
    res.status(201).json({ ...rows[0], members: [] });
  } catch (err) { next(err); }
}

async function update(req, res, next) {
  try {
    const { id } = req.params;
    const { team_name, lead_name } = req.body;
    const { rows } = await pool.query(
      'UPDATE warehouse_teams SET team_name = COALESCE($1, team_name), lead_name = COALESCE($2, lead_name) WHERE id = $3 RETURNING *',
      [team_name || null, lead_name || null, id]
    );
    if (!rows.length) return res.status(404).json({ message: 'Team not found' });
    await logAction({ userId: req.user.id, actionType: 'TEAM_UPDATE', description: `Updated team: ${rows[0].team_name}`, entityType: 'warehouse_team', entityId: id });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

async function remove(req, res, next) {
  try {
    const { id } = req.params;
    const { rows } = await pool.query('DELETE FROM warehouse_teams WHERE id = $1 RETURNING team_name', [id]);
    if (!rows.length) return res.status(404).json({ message: 'Team not found' });
    await logAction({ userId: req.user.id, actionType: 'TEAM_DELETE', description: `Deleted team: ${rows[0].team_name}`, entityType: 'warehouse_team', entityId: id });
    res.json({ message: 'Team deleted' });
  } catch (err) { next(err); }
}

async function addMember(req, res, next) {
  try {
    const { id } = req.params;
    const { member_name } = req.body;
    if (!member_name) return res.status(400).json({ message: 'member_name is required' });
    const { rows } = await pool.query(
      'INSERT INTO team_members (team_id, member_name) VALUES ($1,$2) RETURNING *',
      [id, member_name]
    );
    await logAction({ userId: req.user.id, actionType: 'MEMBER_ADD', description: `Added ${member_name} to team #${id}`, entityType: 'warehouse_team', entityId: id });
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

async function removeMember(req, res, next) {
  try {
    const { id, memberId } = req.params;
    const { rows } = await pool.query(
      'DELETE FROM team_members WHERE id = $1 AND team_id = $2 RETURNING member_name',
      [memberId, id]
    );
    if (!rows.length) return res.status(404).json({ message: 'Member not found' });
    await logAction({ userId: req.user.id, actionType: 'MEMBER_REMOVE', description: `Removed ${rows[0].member_name} from team #${id}`, entityType: 'warehouse_team', entityId: id });
    res.json({ message: 'Member removed' });
  } catch (err) { next(err); }
}

module.exports = { list, create, update, remove, addMember, removeMember };
