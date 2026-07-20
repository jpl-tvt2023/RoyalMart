import api from './axios';

export const getUsers = () => api.get('/users');
// id + name only, open to every logged-in user (unlike getUsers, Admin/Owner-only).
export async function listUsersLite(params) {
  const { data } = await api.get('/users/lite', { params });
  return data;
}
export const createUser = (data) => api.post('/users', data);
export const updateUser = (id, data) => api.put(`/users/${id}`, data);
export const deleteUser = (id, { force } = {}) => api.delete(`/users/${id}${force ? '?force=true' : ''}`);
export const resetUserPassword = (id, newPassword) => api.post(`/users/${id}/reset-password`, { newPassword });
