import api from './axios';

export const getSupplierPOs = () => api.get('/supplier-pos');
export const createSupplierPO = (data) => api.post('/supplier-pos', data);
export const updatePOStatus = (id, status) => api.patch(`/supplier-pos/${id}/status`, { status });
