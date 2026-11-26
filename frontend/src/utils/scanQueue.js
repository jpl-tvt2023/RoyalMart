// The Barcode Station's pending-scan queue (stock counts, migration 102).
//
// Every scan goes into this queue first and is sent from it, so a scan made
// while the Wi-Fi is down -- or just before the page reloads -- is never lost.
// It lives in localStorage and is sent in small groups. Re-sending is safe:
// the server's PRIMARY KEY (count_id, label_key) drops a scan it already has.
//
// Pure functions over an array of { count_id, floor_id, operator, key }, plus
// load/save wrappers that survive storage that throws (private windows,
// blocked site data). No backend twin.

export const QUEUE_KEY = 'roms:barcodeStation:pendingScans';

// Keys per request: small enough to answer fast, so the result card keeps up
// with a scanner gun, while a backlog still drains in a few requests.
export const SEND_MAX = 25;

const sameGroup = (a, b) => a.count_id === b.count_id && a.floor_id === b.floor_id && a.operator === b.operator;

// Adds a scan unless the same key is already waiting for the same count.
// Returns { queue, added }.
export function enqueue(queue, item) {
  if (queue.some((q) => q.count_id === item.count_id && q.key === item.key)) return { queue, added: false };
  return { queue: [...queue, item], added: true };
}

// The next request to send: the oldest scan's count, floor and operator, and
// up to `max` of the keys that share them. null when there is nothing to send.
export function nextBatch(queue, max = SEND_MAX) {
  if (!queue.length) return null;
  const head = queue[0];
  const keys = queue.filter((q) => sameGroup(q, head)).slice(0, max).map((q) => q.key);
  return { count_id: head.count_id, floor_id: head.floor_id, operator: head.operator, keys };
}

// Removes what a successful request carried.
export function removeSent(queue, batch) {
  const sent = new Set(batch.keys);
  return queue.filter((q) => !(sameGroup(q, batch) && sent.has(q.key)));
}

// Drops every scan for a count the server will no longer take (it was closed).
export const dropCount = (queue, countId) => queue.filter((q) => q.count_id !== countId);

const valid = (q) => q && Number.isInteger(q.count_id) && Number.isInteger(q.floor_id)
  && typeof q.operator === 'string' && /^[1-9]\d{7}$/.test(String(q.key));

export function loadQueue() {
  try {
    const parsed = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter(valid) : [];
  } catch {
    return [];
  }
}

export function saveQueue(queue) {
  try {
    if (queue.length) localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
    else localStorage.removeItem(QUEUE_KEY);
  } catch { /* storage unavailable: the queue still works for this page */ }
}
