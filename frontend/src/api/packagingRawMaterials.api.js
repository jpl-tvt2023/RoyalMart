import api from './axios';

export const getPackagingRawMaterials       = ()         => api.get('/packaging-raw-materials');
export const createPackagingRawMaterial     = (data)     => api.post('/packaging-raw-materials', data);
export const updatePackagingRawMaterial     = (id, data) => api.put(`/packaging-raw-materials/${id}`, data);
export const deletePackagingRawMaterial     = (id)       => api.delete(`/packaging-raw-materials/${id}`);
export const bulkDeletePackagingRawMaterials = (ids)     => api.post('/packaging-raw-materials/bulk-delete', { ids });
export const bulkUpsertPackagingRawMaterials = (rows)    => api.post('/packaging-raw-materials/bulk', { rows });
