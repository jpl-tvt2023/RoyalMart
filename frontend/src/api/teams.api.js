import api from './axios';

export const getTeams = () => api.get('/teams');
export const createTeam = (data) => api.post('/teams', data);
export const updateTeam = (id, data) => api.put(`/teams/${id}`, data);
export const deleteTeam = (id) => api.delete(`/teams/${id}`);
export const addMember = (teamId, member_name) => api.post(`/teams/${teamId}/members`, { member_name });
export const removeMember = (teamId, memberId) => api.delete(`/teams/${teamId}/members/${memberId}`);
