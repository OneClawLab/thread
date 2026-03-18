// Feature: thread-core, Property 7: thread_path_slug 长度约束
import { describe, it } from 'vitest';
import * as fc from 'fast-check';
import { buildTaskId } from '../../src/notifier-client.js';

/**
 * Validates: Requirements 10.1, 10.2, 10.3
 *
 * Property 7: thread_path_slug 长度约束（Invariant）
 * 对于任意 thread 目录路径，生成的 thread_path_slug 长度应不超过 40 个字符，
 * 且仅包含字母、数字和连字符。
 */
describe('Property 7: thread_path_slug 长度约束', () => {
  it('对任意路径字符串，slug 长度 ≤ 40 且仅含字母数字和连字符', () => {
    // 使用非空字符串：空路径不是合法的 thread 目录
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (path) => {
        const taskId = buildTaskId(path);
        // taskId 格式为 "dispatch-<slug>"，去掉前缀得到 slug
        const slug = taskId.replace(/^dispatch-/, '');

        // 长度约束：slug 不超过 40 个字符
        if (slug.length > 40) return false;

        // 字符约束：仅含字母、数字和连字符
        if (!/^[a-zA-Z0-9-]+$/.test(slug)) return false;

        return true;
      }),
      { numRuns: 100 }
    );
  });
});
