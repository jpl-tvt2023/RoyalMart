import api from './axios';

// The stitching party master: processing houses and the buyers finished goods
// are sold to. Reads are open to every logged-in user because the challan form
// needs the dropdown on every dispatch; writes are Admin/Owner only, enforced
// server-side.
//
// Each party carries `uses` -- the destinations it may serve -- which is what
// narrows the challan form's dropdown to parties that can actually do the job
// being dispatched.
export async function listStitchingParties() {
  const { data } = await api.get('/configurations/stitching-parties');
  return data;
}

export async function createStitchingParty(payload) {
  const { data } = await api.post('/configurations/stitching-parties', payload);
  return data;
}

export async function updateStitchingParty(id, payload) {
  const { data } = await api.patch(`/configurations/stitching-parties/${id}`, payload);
  return data;
}

export async function deleteStitchingParty(id) {
  const { data } = await api.delete(`/configurations/stitching-parties/${id}`);
  return data;
}
