import api from './axios';

export const getPackaging = () => api.get('/packaging');
export const createPackaging = (data) => api.post('/packaging', data);
export const updatePackaging = (id, data) => api.put(`/packaging/${id}`, data);
export const updatePackagingQty = (id, on_hand_qty, note) => api.patch(`/packaging/${id}/qty`, { on_hand_qty, note });
export const deletePackaging = (id) => api.delete(`/packaging/${id}`);
export const getPackagingAudit = (id) => api.get(`/packaging/${id}/audit`);
