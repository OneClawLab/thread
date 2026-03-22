// Feature: thread-core, Property 5: subscribe round trip
// Feature: thread-core, Property 6: unsubscribe round trip

import { describe, it } from 'vitest';
import * as fc from 'fast-check';
import {
  insertSubscription,
  getSubscription,
  deleteSubscription,
} from '../../src/db/queries.js';
import { createTestThread } from '../helpers/thread-helpers.js';

/**
 * Validates: Requirements 5.1, 5.5
 */

const subscriptionArb = fc.record({
  consumer_id: fc.string({ minLength: 1 }),
  handler_cmd: fc.string({ minLength: 1 }),
  filter: fc.option(fc.string({ minLength: 1 }), { nil: null }),
});

describe('Property 5: subscribe 后可查询（Round Trip）', () => {
  it('对任意合法 Subscription，insertSubscription 后 getSubscription 应返回完全相同的记录', () => {
    fc.assert(
      fc.property(subscriptionArb, (sub) => {
        const t = createTestThread();
        try {
          insertSubscription(t.db, sub);
          const result = getSubscription(t.db, sub.consumer_id);

          if (result === null) return false;
          if (result.consumer_id !== sub.consumer_id) return false;
          if (result.handler_cmd !== sub.handler_cmd) return false;

          // filter: null stays null, string stays string
          const expectedFilter = sub.filter ?? null;
          if (result.filter !== expectedFilter) return false;

          return true;
        } finally {
          t.cleanup();
        }
      }),
      { numRuns: 100 }
    );
  });
});

describe('Property 6: unsubscribe 后不可查询（Round Trip）', () => {
  it('对任意已存在的 consumer_id，deleteSubscription 后 getSubscription 应返回 null', () => {
    fc.assert(
      fc.property(subscriptionArb, (sub) => {
        const t = createTestThread();
        try {
          insertSubscription(t.db, sub);
          deleteSubscription(t.db, sub.consumer_id);
          const result = getSubscription(t.db, sub.consumer_id);
          return result === null;
        } finally {
          t.cleanup();
        }
      }),
      { numRuns: 100 }
    );
  });
});
