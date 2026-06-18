import api from './axios';

export const getProducts   = ()        => api.get('/products');
export const createProduct = (data)    => api.post('/products', data);
export const updateProduct = (id,data) => api.put(`/products/${id}`, data);
export const deleteProduct = (id)      => api.delete(`/products/${id}`);
export const bulkDeleteProducts = (ids) => api.post('/products/bulk-delete', { ids });
export const bulkUpsertProducts = (rows) => api.post('/products/bulk', { rows });
