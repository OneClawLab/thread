// Feature: thread-core, Property 2: batch push 原子性

import { describe, it } from 'vitest';
import * as fc from 'fast-check';
import { insertEventsBatch, getEventCount } from '../../src/db/queries.js';
import { createTestThread } from '../helpers/thread-helpers.js';

/**
 * Validates: Requirements 2.7, 9.2
 *
 * Property 2: batch push 原子性（Invariant）
 * 2a: 对任意 N 条 payload 的 batch，insertEventsBatch 后 getEventCount 恰好增加 N
 * 2b: 模拟失败时（事务中途抛出异常），事件总数不变（全部回滚）
 */

const payloadArb = fc.record({
  source: fc.string({ minLength: 1 }),
  type: fc.string({ minLength: 1 }),
  subtype: fc.option(fc.string({ minLength: 1 }), { nil: null }),
  content: fc.string({ minLength: 1 }),
});

const batchArb = fc.array(payloadArb, { minLength: 1, maxLength: 20 });

describe('Property 2a: batch push 后事件总数恰好增加 N', () => {
  it('对任意 N 条 payload 的 batch，insertEventsBatch 后 getEventCount 恰好增加 N', () => {
    fc.assert(
      fc.property(batchArb, (payloads) => {
        const t = createTestThread();
        try {
          const before = getEventCount(t.db);
          const ids = insertEventsBatch(t.db, payloads);
          const after = getEventCount(t.db);

          // 事件总数恰好增加 N
          if (after - before !== payloads.length) return false;
          // 返回的 id 列表长度也应为 N
          if (ids.length !== payloads.length) return false;

          return true;
        } finally {
          t.cleanup();
        }
      }),
      { numRuns: 100 }
    );
  });
});

describe('Property 2b: batch push 失败时全部回滚', () => {
  it('事务中途抛出异常时，事件总数不变', () => {
    fc.assert(
      fc.property(batchArb, (payloads) => {
        const t = createTestThread();
        try {
          const before = getEventCount(t.db);

          // 在外层事务中调用 insertEventsBatch，然后故意抛出异常触发回滚
          const outerTxn = t.db.transaction(() => {
            insertEventsBatch(t.db, payloads);
            throw new Error('simulated failure');
          });

          let threw = false;
          try {
            outerTxn();
          } catch {
            threw = true;
          }

          if (!threw) return false;

          const after = getEventCount(t.db);
          // 全部回滚，事件总数不变
          return after === before;
        } finally {
          t.cleanup();
        }
      }),
      { numRuns: 100 }
    );
  });
});
