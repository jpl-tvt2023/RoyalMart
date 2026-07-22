import api from './axios';

export async function listCompanies() {
  const { data } = await api.get('/configurations/companies');
  return data;
}

export async function createCompany(payload) {
  const { data } = await api.post('/configurations/companies', payload);
  return data;
}

export async function updateCompany(id, payload) {
  const { data } = await api.patch(`/configurations/companies/${id}`, payload);
  return data;
}

export async function deleteCompany(id) {
  const { data } = await api.delete(`/configurations/companies/${id}`);
  return data;
}
