import { describe, test, expect, beforeEach } from 'vitest';
import {
  enqueue, nextBatch, removeSent, loadQueue, saveQueue, QUEUE_KEY, SEND_MAX,
} from '../scanQueue';

// The station's pending-scan queue (stock counts, migrations 102, 103): scans
// are queued, sent in groups, and survive a reload. Re-sending is safe
// server-side (one scan per sticker per day), so the queue only has to never
// LOSE one. The server picks the day, so an item carries no count.

const scan = (key, over = {}) => ({ floor_id: 10, operator: 'Suresh', key, ...over });

describe('enqueue', () => {
  test('adds a scan, and skips a key already waiting', () => {
    let { queue, added } = enqueue([], scan('48213907'));
    expect(added).toBe(true);
    ({ queue, added } = enqueue(queue, scan('48213907', { floor_id: 11 })));
    expect(added).toBe(false);
    expect(queue).toEqual([scan('48213907')]);
  });

  test('keeps only floor, operator and key', () => {
    const { queue } = enqueue([], { ...scan('48213907'), count_id: 4, extra: true });
    expect(queue).toEqual([scan('48213907')]);
  });
});

describe('nextBatch / removeSent', () => {
  test('groups the oldest scan with others of the same floor and operator', () => {
    const q = [scan('11111111'), scan('22222222', { floor_id: 11 }), scan('33333333'), scan('44444444', { operator: 'Ravi' })];
    expect(nextBatch(q)).toEqual({ floor_id: 10, operator: 'Suresh', keys: ['11111111', '33333333'] });
    const left = removeSent(q, nextBatch(q));
    expect(left.map((s) => s.key)).toEqual(['22222222', '44444444']);
    expect(nextBatch(left).floor_id).toBe(11);
  });

  test('caps a batch, and returns null when empty', () => {
    const q = Array.from({ length: SEND_MAX + 5 }, (_, i) => scan(String(10000000 + i)));
    expect(nextBatch(q).keys).toHaveLength(SEND_MAX);
    expect(nextBatch([])).toBeNull();
  });
});

describe('loadQueue / saveQueue', () => {
  beforeEach(() => localStorage.clear());

  test('round-trips through localStorage, and clears the key when empty', () => {
    saveQueue([scan('48213907')]);
    expect(loadQueue()).toEqual([scan('48213907')]);
    saveQueue([]);
    expect(localStorage.getItem(QUEUE_KEY)).toBeNull();
  });

  test('ignores junk in storage', () => {
    localStorage.setItem(QUEUE_KEY, 'not json');
    expect(loadQueue()).toEqual([]);
    localStorage.setItem(QUEUE_KEY, JSON.stringify([scan('48213907'), { key: '1' }, null, scan('12', {})]));
    expect(loadQueue()).toEqual([scan('48213907')]);
  });

  test('items left by the old station (with a count_id) still load, once per key', () => {
    localStorage.setItem(QUEUE_KEY, JSON.stringify([
      { count_id: 3, ...scan('48213907') },
      { count_id: 4, ...scan('48213907') },
      { count_id: 4, ...scan('55555555') },
    ]));
    expect(loadQueue()).toEqual([scan('48213907'), scan('55555555')]);
  });
});
