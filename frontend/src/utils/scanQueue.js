// The Barcode Station's pending-scan queue (stock counts, migrations 102, 103).
//
// Every scan goes into this queue first and is sent from it, so a scan made
// while the Wi-Fi is down -- or just before the page reloads -- is never lost.
// It lives in localStorage and is sent in small groups. Re-sending is safe:
// the server keeps one scan per sticker per day (PRIMARY KEY (count_id,
// label_key) on today's count).
//
// Since 103 the count is the IST day, chosen by the server when a scan
// ARRIVES -- so an item carries no count, only { floor_id, operator, key }.
// Pure functions over that array, plus load/save wrappers that survive
// storage that throws (private windows, blocked site data). No backend twin.

export const QUEUE_KEY = 'roms:barcodeStation:pendingScans';

// Keys per request: small enough to answer fast, so the result card keeps up
// with a scanner gun, while a backlog still drains in a few requests.
export const SEND_MAX = 25;

const sameGroup = (a, b) => a.floor_id === b.floor_id && a.operator === b.operator;

// Adds a scan unless the same key is already waiting. Returns { queue, added }.
export function enqueue(queue, item) {
  if (queue.some((q) => q.key === item.key)) return { queue, added: false };
  return { queue: [...queue, { floor_id: item.floor_id, operator: item.operator, key: item.key }], added: true };
}

// The next request to send: the oldest scan's floor and operator, and up to
// `max` of the keys that share them. null when there is nothing to send.
export function nextBatch(queue, max = SEND_MAX) {
  if (!queue.length) return null;
  const head = queue[0];
  const keys = queue.filter((q) => sameGroup(q, head)).slice(0, max).map((q) => q.key);
  return { floor_id: head.floor_id, operator: head.operator, keys };
}

// Removes what a successful request carried.
export function removeSent(queue, batch) {
  const sent = new Set(batch.keys);
  return queue.filter((q) => !(sameGroup(q, batch) && sent.has(q.key)));
}

const valid = (q) => q && Number.isInteger(q.floor_id)
  && typeof q.operator === 'string' && /^[1-9]\d{7}$/.test(String(q.key));

// Items left by the 102 station also carry a count_id -- dropped here, so they
// are sent into today's count like any other.
export function loadQueue() {
  try {
    const parsed = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(valid).reduce((q, item) => enqueue(q, item).queue, []);
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
