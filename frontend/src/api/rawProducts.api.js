import api from './axios';

export const getRawProducts       = ()         => api.get('/raw-products');
export const createRawProduct     = (data)     => api.post('/raw-products', data);
export const updateRawProduct     = (id, data) => api.put(`/raw-products/${id}`, data);
export const deleteRawProduct     = (id)       => api.delete(`/raw-products/${id}`);
export const bulkDeleteRawProducts = (ids)     => api.post('/raw-products/bulk-delete', { ids });
export const bulkUpsertRawProducts = (rows)    => api.post('/raw-products/bulk', { rows });
