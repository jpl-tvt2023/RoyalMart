import api from './axios';

export const getInventory = () => api.get('/inventory');
export const getInventoryAudit = (skuId) => api.get(`/inventory/${skuId}/audit`);
