// Feature: thread-core, Property 3: pop 过滤正确性
// Feature: thread-core, Property 4: pop 幂等性

import { describe, it } from 'vitest';
import * as fc from 'fast-check';
import { insertEventsBatch, insertSubscription, popEvents, upsertConsumerProgress, getConsumerProgress } from '../../src/db/queries.js';
import { createTestThread } from '../helpers/thread-helpers.js';

/**
 * Validates: Requirements 3.3, 3.4, 3.7
 *
 * Property 3: pop 过滤正确性（Metamorphic）
 * 对任意 consumer（含非空 filter）和任意 last-event-id，pop 返回的所有事件都应满足：
 *   - id > last-event-id
 *   - 符合 filter 条件（此处 filter 为 type = '<value>'）
 * 不应返回任何不满足条件的事件。
 *
 * Property 4: pop 进度更新幂等性（Idempotence）
 * 对任意 consumer，以相同的 last-event-id 连续执行两次 pop，
 * consumer_progress 中的 last_acked_id 应等于该 last-event-id，
 * 且两次 pop 返回相同的事件集合。
 */

// Arbitraries for event payloads with a controlled type field
const typeArb = fc.constantFrom('alpha', 'beta', 'gamma');

const payloadArb = (type: string) =>
  fc.record({
    source: fc.string({ minLength: 1, maxLength: 20 }),
    type: fc.constant(type),
    subtype: fc.option(fc.string({ minLength: 1, maxLength: 10 }), { nil: null }),
    content: fc.string({ minLength: 1, maxLength: 50 }),
  });

// ─── Property 3 ──────────────────────────────────────────────────────────────

describe('Property 3: pop 过滤正确性', () => {
  it('pop 返回的事件均满足 id > last-event-id 且符合 filter 条件', () => {
    fc.assert(
      fc.property(
        // filterType: the type we filter on
        typeArb,
        // lastEventId: 0..5 so some events may be before/after
        fc.integer({ min: 0, max: 5 }),
        // mix of events: some matching filter type, some not
        fc.array(
          fc.record({
            source: fc.string({ minLength: 1, maxLength: 10 }),
            type: typeArb,
            subtype: fc.constant(null) as fc.Arbitrary<null>,
            content: fc.string({ minLength: 1, maxLength: 20 }),
          }),
          { minLength: 1, maxLength: 15 }
        ),
        (filterType, lastEventId, payloads) => {
          const t = createTestThread();
          try {
            const filter = `type = '${filterType}'`;
            insertSubscription(t.db, { consumer_id: 'c1', handler_cmd: 'echo', filter });
            insertEventsBatch(t.db, payloads);

            const events = popEvents(t.db, lastEventId, filter, 100);

            for (const e of events) {
              // Must satisfy id > lastEventId
              if (e.id <= lastEventId) return false;
              // Must satisfy filter
              if (e.type !== filterType) return false;
            }
            return true;
          } finally {
            t.cleanup();
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('filter=null 时返回所有 id > last-event-id 的事件', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5 }),
        fc.array(
          fc.record({
            source: fc.string({ minLength: 1, maxLength: 10 }),
            type: typeArb,
            subtype: fc.constant(null) as fc.Arbitrary<null>,
            content: fc.string({ minLength: 1, maxLength: 20 }),
          }),
          { minLength: 1, maxLength: 15 }
        ),
        (lastEventId, payloads) => {
          const t = createTestThread();
          try {
            insertEventsBatch(t.db, payloads);

            const events = popEvents(t.db, lastEventId, null, 100);

            // All returned events must have id > lastEventId
            for (const e of events) {
              if (e.id <= lastEventId) return false;
            }

            // Count of events with id > lastEventId in DB should match
            const expected = (
              t.db
                .prepare('SELECT COUNT(*) as cnt FROM events WHERE id > ?')
                .get(lastEventId) as { cnt: number }
            ).cnt;

            return events.length === expected;
          } finally {
            t.cleanup();
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ─── Property 4 ──────────────────────────────────────────────────────────────

describe('Property 4: pop 进度更新幂等性', () => {
  it('以相同 last-event-id 连续两次 pop，consumer_progress 不变且返回事件集相同', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5 }),
        fc.array(
          fc.record({
            source: fc.string({ minLength: 1, maxLength: 10 }),
            type: typeArb,
            subtype: fc.constant(null) as fc.Arbitrary<null>,
            content: fc.string({ minLength: 1, maxLength: 20 }),
          }),
          { minLength: 0, maxLength: 10 }
        ),
        (lastEventId, payloads) => {
          const t = createTestThread();
          try {
            insertSubscription(t.db, { consumer_id: 'c1', handler_cmd: 'echo', filter: null });
            if (payloads.length > 0) {
              insertEventsBatch(t.db, payloads);
            }

            // First pop
            upsertConsumerProgress(t.db, 'c1', lastEventId);
            const events1 = popEvents(t.db, lastEventId, null, 100);
            const progress1 = getConsumerProgress(t.db, 'c1');

            // Second pop with same last-event-id
            upsertConsumerProgress(t.db, 'c1', lastEventId);
            const events2 = popEvents(t.db, lastEventId, null, 100);
            const progress2 = getConsumerProgress(t.db, 'c1');

            // consumer_progress.last_acked_id should equal lastEventId both times
            if (progress1?.last_acked_id !== lastEventId) return false;
            if (progress2?.last_acked_id !== lastEventId) return false;

            // Both pops should return the same events (same ids, same order)
            if (events1.length !== events2.length) return false;
            for (let i = 0; i < events1.length; i++) {
              if (events1[i]!.id !== events2[i]!.id) return false;
            }

            return true;
          } finally {
            t.cleanup();
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
