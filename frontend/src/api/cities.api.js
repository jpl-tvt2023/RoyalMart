import api from './axios';

export async function listCities() {
  const { data } = await api.get('/configurations/cities');
  return data;
}

export async function createCity(payload) {
  const { data } = await api.post('/configurations/cities', payload);
  return data;
}

export async function updateCity(id, payload) {
  const { data } = await api.patch(`/configurations/cities/${id}`, payload);
  return data;
}

export async function deleteCity(id) {
  const { data } = await api.delete(`/configurations/cities/${id}`);
  return data;
}
