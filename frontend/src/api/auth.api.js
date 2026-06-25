import api from './axios';

export const login = (username, password) => api.post('/auth/login', { username, password });
export const refresh = () => api.post('/auth/refresh');
export const changePassword = (data) => api.post('/auth/change-password', data);
export const logout = () => api.post('/auth/logout');
