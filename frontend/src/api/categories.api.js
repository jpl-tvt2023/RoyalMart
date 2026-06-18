import api from './axios';

export async function listCategories() {
  const { data } = await api.get('/configurations/categories');
  return data;
}

export async function createCategory(payload) {
  const { data } = await api.post('/configurations/categories', payload);
  return data;
}

export async function updateCategory(id, payload) {
  const { data } = await api.patch(`/configurations/categories/${id}`, payload);
  return data;
}

export async function deleteCategory(id) {
  const { data } = await api.delete(`/configurations/categories/${id}`);
  return data;
}
