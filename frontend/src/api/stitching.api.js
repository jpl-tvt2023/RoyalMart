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

// The challan a lot is dispatched under. Takes the src because an origin lot is
// a PO receipt and a downstream lot is a stitching entry -- and this is the only
// path by which this page writes to a receipt.
export async function setStitchingChallan(src, id, challanNo) {
  const { data } = await api.patch(`/stitching/${src}/${id}/challan`, { challan_no: challanNo });
  return data;
}

// Send a wrongly recorded hop back to the stage it came from. Takes the src for
// the same reason, and because the server refuses a receipt outright — material
// entered the chain there, so there is nothing behind it to go back to.
export async function revertStitchingLot(src, id, reason) {
  const { data } = await api.post(`/stitching/${src}/${id}/revert`, { reason });
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
