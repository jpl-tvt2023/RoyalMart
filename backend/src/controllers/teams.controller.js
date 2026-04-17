const db = require('../config/db');
const { logAction } = require('../services/auditLog.service');

async function list(req, res, next) {
  try {
    const { rows: teams } = await db.execute('SELECT * FROM warehouse_teams ORDER BY created_at DESC');
    const { rows: members } = await db.execute('SELECT * FROM team_members ORDER BY id');
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
    const { rows } = await db.execute({
      sql: 'INSERT INTO warehouse_teams (team_name, lead_name) VALUES (?,?) RETURNING *',
      args: [team_name, lead_name || null],
    });
    await logAction({ userId: req.user.id, actionType: 'TEAM_CREATE', description: `Created team: ${team_name}`, entityType: 'warehouse_team', entityId: rows[0].id });
    res.status(201).json({ ...rows[0], members: [] });
  } catch (err) { next(err); }
}

async function update(req, res, next) {
  try {
    const { id } = req.params;
    const { team_name, lead_name } = req.body;
    const { rows } = await db.execute({
      sql: 'UPDATE warehouse_teams SET team_name = COALESCE(?, team_name), lead_name = COALESCE(?, lead_name) WHERE id = ? RETURNING *',
      args: [team_name || null, lead_name || null, id],
    });
    if (!rows.length) return res.status(404).json({ message: 'Team not found' });
    await logAction({ userId: req.user.id, actionType: 'TEAM_UPDATE', description: `Updated team: ${rows[0].team_name}`, entityType: 'warehouse_team', entityId: id });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

async function remove(req, res, next) {
  try {
    const { id } = req.params;
    const { rows } = await db.execute({ sql: 'DELETE FROM warehouse_teams WHERE id = ? RETURNING team_name', args: [id] });
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
    const { rows } = await db.execute({
      sql: 'INSERT INTO team_members (team_id, member_name) VALUES (?,?) RETURNING *',
      args: [id, member_name],
    });
    await logAction({ userId: req.user.id, actionType: 'MEMBER_ADD', description: `Added ${member_name} to team #${id}`, entityType: 'warehouse_team', entityId: id });
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

async function removeMember(req, res, next) {
  try {
    const { id, memberId } = req.params;
    const { rows } = await db.execute({
      sql: 'DELETE FROM team_members WHERE id = ? AND team_id = ? RETURNING member_name',
      args: [memberId, id],
    });
    if (!rows.length) return res.status(404).json({ message: 'Member not found' });
    await logAction({ userId: req.user.id, actionType: 'MEMBER_REMOVE', description: `Removed ${rows[0].member_name} from team #${id}`, entityType: 'warehouse_team', entityId: id });
    res.json({ message: 'Member removed' });
  } catch (err) { next(err); }
}

module.exports = { list, create, update, remove, addMember, removeMember };
