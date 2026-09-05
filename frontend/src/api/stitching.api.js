import api from './axios';

export async function listStitchingLots(params) {
  const { data } = await api.get('/stitching', { params });
  return data;
}

// Open-lot count per stage, for the tab badges. Takes the same filter params as
// the list so the badges answer "how many open lots would I see on that tab".
export async function listStitchingStageCounts(params) {
  const { data } = await api.get('/stitching/stage-counts', { params });
  return data;
}

// The full lineage of whatever chain this lot belongs to, already flattened into
// render order with a depth on each node.
export async function getStitchingJourney(src, id) {
  const { data } = await api.get(`/stitching/journey/${src}/${id}`);
  return data;
}

// Close/reopen take the lot type too: a Packed lot may be a forwarded entry or a
// receipt bought straight at that stage, and they live in different tables.
export async function closeStitchingLot(src, id) {
  const { data } = await api.post(`/stitching/${src}/${id}/close`);
  return data;
}

export async function reopenStitchingLot(src, id) {
  const { data } = await api.post(`/stitching/${src}/${id}/reopen`);
  return data;
}

// Record what came back against a challan. One segment: only a challan can be
// received, and every challan is a stitching entry.
export async function receiveStitchingChallan(id, payload) {
  const { data } = await api.post(`/stitching/${id}/receive`, payload);
  return data;
}

// Withdraw a challan that should not exist -- a correction, not a movement.
// Nothing travels anywhere: the quantity stops counting as dispatched.
export async function removeStitchingChallan(id, reason) {
  const { data } = await api.post(`/stitching/${id}/remove`, { reason });
  return data;
}

export async function listStitchingParties() {
  const { data } = await api.get('/stitching/parties');
  return data;
}

// Record a challan: part of a lot dispatched to a processor. Nothing has come
// back yet — that is receiveStitchingChallan. The stage is never sent, and nor
// is the incoming number: the server derives both from the parent.
export async function dispatchStitchingChallan(payload) {
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
