import api from './axios';

export const getSKUs = () => api.get('/skus');
export const createSKU = (data) => api.post('/skus', data);
export const updateSKU = (id, data) => api.put(`/skus/${id}`, data);
export const deleteSKU = (id) => api.delete(`/skus/${id}`);
