import api from './axios';

export const getPackagingProducts = () => api.get('/packaging-products');
