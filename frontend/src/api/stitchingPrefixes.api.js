import api from './axios';

// The incoming-number prefix master. Reads are open to every logged-in user
// because both the outbound PO receipt row and the Stitching forward form need
// the dropdown; writes are Admin/Owner only, enforced server-side.
export async function listStitchingPrefixes() {
  const { data } = await api.get('/configurations/stitching-prefixes');
  return data;
}

export async function createStitchingPrefix(payload) {
  const { data } = await api.post('/configurations/stitching-prefixes', payload);
  return data;
}

export async function updateStitchingPrefix(id, payload) {
  const { data } = await api.patch(`/configurations/stitching-prefixes/${id}`, payload);
  return data;
}

export async function deleteStitchingPrefix(id) {
  const { data } = await api.delete(`/configurations/stitching-prefixes/${id}`);
  return data;
}
