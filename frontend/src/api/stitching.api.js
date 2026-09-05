import api from './axios';

export async function listStitchingLots(params) {
  const { data } = await api.get('/stitching', { params });
  return data;
}

export async function listStitchingParties() {
  const { data } = await api.get('/stitching/parties');
  return data;
}

// Forward part or all of a lot to the next stage. The stage itself is never
// sent — the server derives it from the parent, so it cannot be spoofed.
export async function forwardStitchingLot(payload) {
  const { data } = await api.post('/stitching', payload);
  return data;
}

export async function updateStitchingLot(id, payload) {
  const { data } = await api.patch(`/stitching/${id}`, payload);
  return data;
}

export async function deleteStitchingLot(id) {
  const { data } = await api.delete(`/stitching/${id}`);
  return data;
}

export async function restoreStitchingLot(id) {
  const { data } = await api.post(`/stitching/${id}/restore`);
  return data;
}
