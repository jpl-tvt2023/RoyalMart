import api from './axios';

export async function listCouriers() {
  const { data } = await api.get('/couriers');
  return data;
}

export async function createCourier(payload) {
  const { data } = await api.post('/couriers', payload);
  return data;
}

export async function updateCourier(id, payload) {
  const { data } = await api.patch(`/couriers/${id}`, payload);
  return data;
}

export async function deleteCourier(id) {
  const { data } = await api.delete(`/couriers/${id}`);
  return data;
}
