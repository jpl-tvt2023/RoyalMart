import api from './axios';

// Floors master (098) -- Admin -> Purchase Config -> Floors.

export async function listFloors() {
  const { data } = await api.get('/configurations/floors');
  return data;
}

export async function createFloor(payload) {
  const { data } = await api.post('/configurations/floors', payload);
  return data;
}

export async function updateFloor(id, payload) {
  const { data } = await api.patch(`/configurations/floors/${id}`, payload);
  return data;
}

export async function deleteFloor(id) {
  const { data } = await api.delete(`/configurations/floors/${id}`);
  return data;
}
