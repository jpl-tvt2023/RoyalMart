import api from './axios';

export const getVendorCodes = () => api.get('/product-vendor-codes');
export const createVendorCode = (data) => api.post('/product-vendor-codes', data);
export const updateVendorCode = (id, data) => api.put(`/product-vendor-codes/${id}`, data);
export const deleteVendorCode = (id) => api.delete(`/product-vendor-codes/${id}`);
export const bulkUpsertVendorCodes = (rows) => api.post('/product-vendor-codes/bulk', { rows });
