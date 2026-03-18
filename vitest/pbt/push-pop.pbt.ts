// Feature: thread-core, Property 1: push 后事件可查询

import { describe, it, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { insertEvent } from '../../src/db/queries.js';
import { popEvents } from '../../src/db/queries.js';
import { createTestThread } from '../helpers/thread-helpers.js';
import type { TestThread } from '../helpers/thread-helpers.js';

/**
 * Validates: Requirements 2.1, 2.2, 2.3, 2.4
 *
 * Property 1: push 后事件可查询（Round Trip）
 * 对于任意合法的 PushPayload，执行 insertEvent 后，通过 popEvents(lastEventId=0)
 * 应能取回该事件，且 source、type、subtype、content 字段与原始 payload 完全一致。
 */
describe('Property 1: push 后事件可查询（Round Trip）', () => {
  let thread: TestThread | null = null;

  afterEach(() => {
    thread?.cleanup();
    thread = null;
  });

  it('对任意合法 PushPayload，insertEvent 后 popEvents 可取回字段完全一致的事件', () => {
    fc.assert(
      fc.property(
        fc.record({
          source: fc.string({ minLength: 1 }),
          type: fc.string({ minLength: 1 }),
          subtype: fc.option(fc.string({ minLength: 1 }), { nil: null }),
          content: fc.string({ minLength: 1 }),
        }),
        (payload) => {
          // 每次迭代使用独立的临时 DB，避免状态污染
          const t = createTestThread();
          try {
            const id = insertEvent(t.db, payload);

            // popEvents(db, lastEventId=0, filter=null, limit=100)
            const events = popEvents(t.db, 0, null, 100);

            // 应能取回至少一条事件
            const found = events.find((e) => e.id === id);
            if (!found) return false;

            // 字段完全一致
            if (found.source !== payload.source) return false;
            if (found.type !== payload.type) return false;
            if (found.content !== payload.content) return false;

            // subtype：payload 中 undefined/null 均应存储为 null
            const expectedSubtype = payload.subtype ?? null;
            if (found.subtype !== expectedSubtype) return false;

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
