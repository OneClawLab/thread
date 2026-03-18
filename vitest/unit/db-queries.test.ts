import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestThread, type TestThread } from '../helpers/thread-helpers.js';
import {
  insertEvent,
  insertEventsBatch,
  getSubscription,
  getSubscriptions,
  insertSubscription,
  deleteSubscription,
  getConsumerProgress,
  upsertConsumerProgress,
  popEvents,
  hasUnconsumedEvents,
  getEventCount,
  getThreadInfo,
} from '../../src/db/queries.js';

let t: TestThread;

beforeEach(() => { t = createTestThread(); });
afterEach(() => { t.cleanup(); });

describe('insertEvent', () => {
  it('returns an auto-incremented id starting at 1', () => {
    const id = insertEvent(t.db, { source: 'a', type: 'message', content: 'hi' });
    expect(id).toBe(1);
  });

  it('stores subtype as null when not provided', () => {
    insertEvent(t.db, { source: 'a', type: 'message', content: 'hi' });
    const row = t.db.prepare('SELECT subtype FROM events WHERE id = 1').get() as { subtype: string | null };
    expect(row.subtype).toBeNull();
  });

  it('stores subtype when provided', () => {
    insertEvent(t.db, { source: 'a', type: 'record', subtype: 'toolcall', content: '{}' });
    const row = t.db.prepare('SELECT subtype FROM events WHERE id = 1').get() as { subtype: string };
    expect(row.subtype).toBe('toolcall');
  });
});

describe('insertEventsBatch', () => {
  it('inserts all events in a single transaction and returns ids', () => {
    const ids = insertEventsBatch(t.db, [
      { source: 'a', type: 'message', content: '1' },
      { source: 'b', type: 'message', content: '2' },
      { source: 'c', type: 'message', content: '3' },
    ]);
    expect(ids).toEqual([1, 2, 3]);
    expect(getEventCount(t.db)).toBe(3);
  });

  it('returns empty array for empty input', () => {
    const ids = insertEventsBatch(t.db, []);
    expect(ids).toEqual([]);
  });
});

describe('subscriptions', () => {
  it('inserts and retrieves a subscription', () => {
    insertSubscription(t.db, { consumer_id: 'c1', handler_cmd: 'echo hi', filter: null });
    const sub = getSubscription(t.db, 'c1');
    expect(sub).toMatchObject({ consumer_id: 'c1', handler_cmd: 'echo hi', filter: null });
  });

  it('returns null for non-existent consumer', () => {
    expect(getSubscription(t.db, 'nope')).toBeNull();
  });

  it('deletes a subscription', () => {
    insertSubscription(t.db, { consumer_id: 'c1', handler_cmd: 'echo', filter: null });
    deleteSubscription(t.db, 'c1');
    expect(getSubscription(t.db, 'c1')).toBeNull();
  });
});

describe('consumer progress', () => {
  it('returns null for unknown consumer', () => {
    expect(getConsumerProgress(t.db, 'unknown')).toBeNull();
  });

  it('upserts progress correctly', () => {
    upsertConsumerProgress(t.db, 'c1', 5);
    const p = getConsumerProgress(t.db, 'c1');
    expect(p?.last_acked_id).toBe(5);
  });

  it('updates existing progress', () => {
    upsertConsumerProgress(t.db, 'c1', 5);
    upsertConsumerProgress(t.db, 'c1', 10);
    expect(getConsumerProgress(t.db, 'c1')?.last_acked_id).toBe(10);
  });
});

describe('popEvents', () => {
  beforeEach(() => {
    insertEventsBatch(t.db, [
      { source: 'a', type: 'message', content: '1' },
      { source: 'b', type: 'record', content: '2' },
      { source: 'a', type: 'message', content: '3' },
    ]);
  });

  it('returns events with id > lastEventId', () => {
    const events = popEvents(t.db, 0, null, 100);
    expect(events).toHaveLength(3);
    expect(events[0]?.id).toBe(1);
  });

  it('respects lastEventId', () => {
    const events = popEvents(t.db, 1, null, 100);
    expect(events).toHaveLength(2);
    expect(events[0]?.id).toBe(2);
  });

  it('applies filter correctly', () => {
    const events = popEvents(t.db, 0, "type = 'message'", 100);
    expect(events).toHaveLength(2);
    expect(events.every(e => e.type === 'message')).toBe(true);
  });

  it('respects limit', () => {
    const events = popEvents(t.db, 0, null, 2);
    expect(events).toHaveLength(2);
  });

  it('returns empty array when no events match', () => {
    const events = popEvents(t.db, 100, null, 100);
    expect(events).toHaveLength(0);
  });
});

describe('hasUnconsumedEvents', () => {
  it('returns false when no events', () => {
    expect(hasUnconsumedEvents(t.db, 0, null)).toBe(false);
  });

  it('returns true when events exist beyond lastAckedId', () => {
    insertEvent(t.db, { source: 'a', type: 'message', content: 'hi' });
    expect(hasUnconsumedEvents(t.db, 0, null)).toBe(true);
  });

  it('returns false when all events are acked', () => {
    insertEvent(t.db, { source: 'a', type: 'message', content: 'hi' });
    expect(hasUnconsumedEvents(t.db, 1, null)).toBe(false);
  });

  it('applies filter', () => {
    insertEvent(t.db, { source: 'a', type: 'record', content: 'hi' });
    expect(hasUnconsumedEvents(t.db, 0, "type = 'message'")).toBe(false);
    expect(hasUnconsumedEvents(t.db, 0, "type = 'record'")).toBe(true);
  });
});

describe('getSubscriptions', () => {
  it('returns empty array when no subscriptions', () => {
    expect(getSubscriptions(t.db)).toEqual([]);
  });

  it('returns all subscriptions', () => {
    insertSubscription(t.db, { consumer_id: 'c1', handler_cmd: 'cmd1', filter: null });
    insertSubscription(t.db, { consumer_id: 'c2', handler_cmd: 'cmd2', filter: "type = 'x'" });
    const subs = getSubscriptions(t.db);
    expect(subs).toHaveLength(2);
    expect(subs.map(s => s.consumer_id).sort()).toEqual(['c1', 'c2']);
  });
});

describe('popEvents — id=0 boundary', () => {
  it('with lastEventId=0 returns all events from id=1', () => {
    insertEventsBatch(t.db, [
      { source: 'a', type: 'msg', content: '1' },
      { source: 'b', type: 'msg', content: '2' },
    ]);
    const events = popEvents(t.db, 0, null, 100);
    expect(events).toHaveLength(2);
    expect(events[0]?.id).toBe(1);
    expect(events[1]?.id).toBe(2);
  });

  it('with null filter returns all events (no extra filtering)', () => {
    insertEventsBatch(t.db, [
      { source: 'a', type: 'alpha', content: '1' },
      { source: 'b', type: 'beta', content: '2' },
    ]);
    const events = popEvents(t.db, 0, null, 100);
    expect(events).toHaveLength(2);
  });

  it('returns empty array when table is empty', () => {
    expect(popEvents(t.db, 0, null, 100)).toEqual([]);
  });
});

describe('getEventCount', () => {
  it('returns 0 for empty table', () => {
    expect(getEventCount(t.db)).toBe(0);
  });

  it('returns correct count after inserts', () => {
    insertEventsBatch(t.db, [
      { source: 'a', type: 'msg', content: '1' },
      { source: 'b', type: 'msg', content: '2' },
    ]);
    expect(getEventCount(t.db)).toBe(2);
  });
});

describe('getThreadInfo', () => {
  it('returns zero event_count and empty subscriptions for fresh db', () => {
    const info = getThreadInfo(t.db);
    expect(info.event_count).toBe(0);
    expect(info.subscriptions).toEqual([]);
  });

  it('returns correct event_count', () => {
    insertEvent(t.db, { source: 'a', type: 'msg', content: 'hi' });
    insertEvent(t.db, { source: 'b', type: 'msg', content: 'bye' });
    const info = getThreadInfo(t.db);
    expect(info.event_count).toBe(2);
  });

  it('includes subscriptions with last_acked_id=0 when no progress recorded', () => {
    insertSubscription(t.db, { consumer_id: 'c1', handler_cmd: 'echo', filter: null });
    const info = getThreadInfo(t.db);
    expect(info.subscriptions).toHaveLength(1);
    expect(info.subscriptions[0]?.last_acked_id).toBe(0);
    expect(info.subscriptions[0]?.updated_at).toBeNull();
  });

  it('includes consumer progress when available', () => {
    insertSubscription(t.db, { consumer_id: 'c1', handler_cmd: 'echo', filter: null });
    upsertConsumerProgress(t.db, 'c1', 7);
    const info = getThreadInfo(t.db);
    expect(info.subscriptions[0]?.last_acked_id).toBe(7);
    expect(info.subscriptions[0]?.updated_at).toBeTruthy();
  });
});
