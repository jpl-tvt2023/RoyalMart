import { describe, test, expect, beforeEach } from 'vitest';
import {
  enqueue, nextBatch, removeSent, dropCount, loadQueue, saveQueue, QUEUE_KEY, SEND_MAX,
} from '../scanQueue';

// The station's pending-scan queue (stock counts, migration 102): scans are
// queued, sent in groups, and survive a reload. Re-sending is safe server-side
// (one scan per sticker per count), so the queue only has to never LOSE one.

const scan = (key, over = {}) => ({ count_id: 1, floor_id: 10, operator: 'Suresh', key, ...over });

describe('enqueue', () => {
  test('adds a scan, and skips a key already waiting for the same count', () => {
    let { queue, added } = enqueue([], scan('48213907'));
    expect(added).toBe(true);
    ({ queue, added } = enqueue(queue, scan('48213907', { floor_id: 11 })));
    expect(added).toBe(false);
    expect(queue).toHaveLength(1);
    // The same key on another count is a different scan.
    expect(enqueue(queue, scan('48213907', { count_id: 2 })).added).toBe(true);
  });
});

describe('nextBatch / removeSent', () => {
  test('groups the oldest scan with others of the same count, floor and operator', () => {
    const q = [scan('11111111'), scan('22222222', { floor_id: 11 }), scan('33333333')];
    expect(nextBatch(q)).toEqual({ count_id: 1, floor_id: 10, operator: 'Suresh', keys: ['11111111', '33333333'] });
    const left = removeSent(q, nextBatch(q));
    expect(left.map((s) => s.key)).toEqual(['22222222']);
    expect(nextBatch(left).floor_id).toBe(11);
  });

  test('caps a batch, and returns null when empty', () => {
    const q = Array.from({ length: SEND_MAX + 5 }, (_, i) => scan(String(10000000 + i)));
    expect(nextBatch(q).keys).toHaveLength(SEND_MAX);
    expect(nextBatch([])).toBeNull();
  });

  test('dropCount clears one count only', () => {
    const q = [scan('11111111'), scan('22222222', { count_id: 2 })];
    expect(dropCount(q, 1).map((s) => s.key)).toEqual(['22222222']);
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
});
