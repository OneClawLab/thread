/**
 * Property-based tests for ThreadStore (push/pushBatch/peek/close)
 *
 * Validates: Requirements 5.1, 5.3, 5.4, 6.1, 6.2, 7.1, 7.2, 7.3, 7.5, 8.2, 9.2
 */

import { describe, it, vi, afterEach } from 'vitest'
import * as fc from 'fast-check'
import * as os from 'node:os'
import { ThreadLib } from '../../src/lib/thread-lib.js'
import { ThreadError } from '../../src/lib/types.js'
import { rm } from '../../src/repo-utils/fs.js'
import { path } from '../../src/repo-utils/path.js'

// ── Generators ───────────────────────────────────────────────────────────────

let counter = 0

function makeTempDir(suffix: string): string {
  return path.join(
    path.toPosixPath(os.tmpdir()),
    `thread-store-pbt-${suffix}-${Date.now()}-${++counter}`
  )
}

const arbSuffix = fc.string({ minLength: 5, maxLength: 20 })
  .filter(s => /^[a-zA-Z0-9]+$/.test(s))

// exactOptionalPropertyTypes: subtype must be absent (not undefined) when not set
const arbEventInput: fc.Arbitrary<import('../../src/lib/types.js').ThreadEventInput> = fc.record({
  source: fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0),
  type: fc.constantFrom('message' as const, 'record' as const),
  content: fc.string({ minLength: 0, maxLength: 200 }),
}).chain(base =>
  fc.boolean().map(hasSubtype => hasSubtype
    ? { ...base, subtype: 'sub' } as import('../../src/lib/types.js').ThreadEventInput
    : base as import('../../src/lib/types.js').ThreadEventInput
  )
)

const arbEventInputArray = fc.array(arbEventInput, { minLength: 1, maxLength: 20 })

// ISO 8601 regex (basic check)
const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/

// ── Property 6: push() round-trip ────────────────────────────────────────────

/**
 * Validates: Requirements 5.1, 5.3, 5.4
 *
 * For any valid ThreadEventInput, after push(), peek({ lastEventId: 0 }) should
 * return the event with matching fields, positive integer id, valid ISO 8601
 * created_at, and subtype as null when not provided.
 */
describe('Property 6: push() round-trip', () => {
  it('push 后 peek(0) 可读回事件，字段一致，id 为正整数，created_at 为 ISO 8601', async () => {
    await fc.assert(
      fc.asyncProperty(arbSuffix, arbEventInput, async (suffix, input) => {
        const dir = makeTempDir(suffix)
        const lib = new ThreadLib()
        let store
        try {
          store = await lib.open(dir)
          const pushed = await store.push(input)
          const events = await store.peek({ lastEventId: 0 })

          if (events.length !== 1) return false
          const ev = events[0]!

          // id must be a positive integer
          if (!Number.isInteger(pushed.id) || pushed.id <= 0) return false
          if (ev.id !== pushed.id) return false

          // created_at must be valid ISO 8601
          if (!ISO_8601_RE.test(pushed.created_at)) return false

          // fields must match input
          if (ev.source !== input.source) return false
          if (ev.type !== input.type) return false
          if (ev.content !== input.content) return false

          // subtype: null when not provided, string when provided
          if (input.subtype === undefined) {
            if (ev.subtype !== null) return false
          } else {
            if (ev.subtype !== input.subtype) return false
          }

          return true
        } finally {
          store?.close()
          await rm(dir, { recursive: true, force: true })
        }
      }),
      { numRuns: 20 }
    )
  })
})

// ── Property 7: push() id 严格递增 ───────────────────────────────────────────

/**
 * Validates: Requirements 5.3
 *
 * For any sequence of events, the ids returned by sequential push() calls
 * should be strictly monotonically increasing (each > previous, all positive integers).
 */
describe('Property 7: push() id 严格递增', () => {
  it('多次 push() 返回的 id 严格单调递增且均为正整数', async () => {
    await fc.assert(
      fc.asyncProperty(arbSuffix, arbEventInputArray, async (suffix, inputs) => {
        const dir = makeTempDir(suffix)
        const lib = new ThreadLib()
        let store
        try {
          store = await lib.open(dir)
          const ids: number[] = []
          for (const input of inputs) {
            const ev = await store.push(input)
            ids.push(ev.id)
          }

          // All ids must be positive integers
          if (!ids.every(id => Number.isInteger(id) && id > 0)) return false

          // Strictly monotonically increasing
          for (let i = 1; i < ids.length; i++) {
            if (ids[i]! <= ids[i - 1]!) return false
          }

          return true
        } finally {
          store?.close()
          await rm(dir, { recursive: true, force: true })
        }
      }),
      { numRuns: 20 }
    )
  })
})

// ── Property 8: pushBatch() round-trip ───────────────────────────────────────

/**
 * Validates: Requirements 6.1, 6.2
 *
 * For any non-empty ThreadEventInput[], pushBatch() returns array of same length
 * in same order, and peek() can read back all events.
 * For empty array, returns [] without modifying db.
 */
describe('Property 8: pushBatch() round-trip', () => {
  it('非空数组：pushBatch 返回长度一致、顺序一致，peek 可读回所有事件', async () => {
    await fc.assert(
      fc.asyncProperty(arbSuffix, arbEventInputArray, async (suffix, inputs) => {
        const dir = makeTempDir(suffix)
        const lib = new ThreadLib()
        let store
        try {
          store = await lib.open(dir)
          const pushed = await store.pushBatch(inputs)

          // Return length must match input
          if (pushed.length !== inputs.length) return false

          // Order must match
          for (let i = 0; i < inputs.length; i++) {
            if (pushed[i]!.source !== inputs[i]!.source) return false
            if (pushed[i]!.content !== inputs[i]!.content) return false
            if (pushed[i]!.type !== inputs[i]!.type) return false
          }

          // peek() must return all events
          const events = await store.peek({ lastEventId: 0, limit: inputs.length + 10 })
          if (events.length !== inputs.length) return false

          // Events must be in same order as input
          for (let i = 0; i < inputs.length; i++) {
            if (events[i]!.source !== inputs[i]!.source) return false
            if (events[i]!.content !== inputs[i]!.content) return false
          }

          return true
        } finally {
          store?.close()
          await rm(dir, { recursive: true, force: true })
        }
      }),
      { numRuns: 20 }
    )
  })

  it('空数组：pushBatch([]) 返回 [] 且不修改数据库', async () => {
    await fc.assert(
      fc.asyncProperty(arbSuffix, arbEventInput, async (suffix, input) => {
        const dir = makeTempDir(suffix)
        const lib = new ThreadLib()
        let store
        try {
          store = await lib.open(dir)
          // Write one event first
          await store.push(input)

          // pushBatch([]) must return []
          const result = await store.pushBatch([])
          if (result.length !== 0) return false

          // DB must still have exactly 1 event
          const events = await store.peek({ lastEventId: 0 })
          if (events.length !== 1) return false

          return true
        } finally {
          store?.close()
          await rm(dir, { recursive: true, force: true })
        }
      }),
      { numRuns: 20 }
    )
  })
})

// ── Property 9: peek() 过滤正确性 ────────────────────────────────────────────

/**
 * Validates: Requirements 7.1, 7.2
 *
 * For any event sequence and any lastEventId N, peek({ lastEventId: N }) returns
 * only events with id > N, ordered by id ASC.
 */
describe('Property 9: peek() 过滤正确性', () => {
  it('peek({ lastEventId: N }) 只返回 id > N 的事件，按 id 升序排列', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbSuffix,
        arbEventInputArray,
        async (suffix, inputs) => {
          const dir = makeTempDir(suffix)
          const lib = new ThreadLib()
          let store
          try {
            store = await lib.open(dir)
            const pushed = await store.pushBatch(inputs)
            const allIds = pushed.map(e => e.id)

            // Pick a random lastEventId from the range [0, max_id]
            // Use the middle id as the cutoff
            const midIndex = Math.floor(allIds.length / 2)
            const lastEventId = midIndex > 0 ? allIds[midIndex - 1]! : 0

            const events = await store.peek({ lastEventId, limit: inputs.length + 10 })

            // All returned events must have id > lastEventId
            if (!events.every(e => e.id > lastEventId)) return false

            // Must be ordered by id ASC
            for (let i = 1; i < events.length; i++) {
              if (events[i]!.id <= events[i - 1]!.id) return false
            }

            // Must contain exactly the events with id > lastEventId
            const expectedCount = allIds.filter(id => id > lastEventId).length
            if (events.length !== expectedCount) return false

            return true
          } finally {
            store?.close()
            await rm(dir, { recursive: true, force: true })
          }
        }
      ),
      { numRuns: 20 }
    )
  })
})

// ── Property 10: peek() limit 约束 ───────────────────────────────────────────

/**
 * Validates: Requirements 7.3
 *
 * For any thread with more than L events, peek({ lastEventId: 0, limit: L })
 * returns ≤ L events. Without limit, defaults to max 100.
 */
describe('Property 10: peek() limit 约束', () => {
  it('peek({ limit: L }) 返回数量 ≤ L', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbSuffix,
        fc.integer({ min: 1, max: 10 }),
        fc.array(arbEventInput, { minLength: 5, maxLength: 15 }),
        async (suffix, limit, inputs) => {
          const dir = makeTempDir(suffix)
          const lib = new ThreadLib()
          let store
          try {
            store = await lib.open(dir)
            await store.pushBatch(inputs)

            const events = await store.peek({ lastEventId: 0, limit })
            return events.length <= limit
          } finally {
            store?.close()
            await rm(dir, { recursive: true, force: true })
          }
        }
      ),
      { numRuns: 20 }
    )
  })

  it('未指定 limit 时默认最多返回 100 条', async () => {
    await fc.assert(
      fc.asyncProperty(arbSuffix, async (suffix) => {
        const dir = makeTempDir(suffix)
        const lib = new ThreadLib()
        let store
        try {
          store = await lib.open(dir)
          // Push 110 events
          const batch = Array.from({ length: 110 }, (_, i) => ({
            source: 'src',
            type: 'message' as const,
            content: `event-${i}`,
          }))
          await store.pushBatch(batch)

          const events = await store.peek({ lastEventId: 0 })
          return events.length <= 100
        } finally {
          store?.close()
          await rm(dir, { recursive: true, force: true })
        }
      }),
      { numRuns: 10 }
    )
  })
})

// ── Property 11: peek() 幂等性 ───────────────────────────────────────────────

/**
 * Validates: Requirements 7.5
 *
 * For any thread and any PeekOptions, multiple peek() calls without writes in
 * between return identical results.
 */
describe('Property 11: peek() 幂等性', () => {
  it('多次 peek() 不写入时返回完全相同的结果', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbSuffix,
        arbEventInputArray,
        fc.integer({ min: 0, max: 10 }),
        async (suffix, inputs, lastEventId) => {
          const dir = makeTempDir(suffix)
          const lib = new ThreadLib()
          let store
          try {
            store = await lib.open(dir)
            await store.pushBatch(inputs)

            const opts = { lastEventId, limit: 50 }
            const result1 = await store.peek(opts)
            const result2 = await store.peek(opts)
            const result3 = await store.peek(opts)

            // All three results must be identical
            if (result1.length !== result2.length) return false
            if (result1.length !== result3.length) return false

            for (let i = 0; i < result1.length; i++) {
              if (result1[i]!.id !== result2[i]!.id) return false
              if (result1[i]!.id !== result3[i]!.id) return false
              if (result1[i]!.content !== result2[i]!.content) return false
            }

            return true
          } finally {
            store?.close()
            await rm(dir, { recursive: true, force: true })
          }
        }
      ),
      { numRuns: 20 }
    )
  })
})

// ── Property 12: close() 后操作抛出错误 ──────────────────────────────────────

/**
 * Validates: Requirements 8.2
 *
 * For any ThreadStore instance, after close(), push(), pushBatch(), and peek()
 * all throw errors.
 */
describe('Property 12: close() 后操作抛出错误', () => {
  it('close() 后调用 push/pushBatch/peek 均抛出错误', async () => {
    await fc.assert(
      fc.asyncProperty(arbSuffix, arbEventInput, async (suffix, input) => {
        const dir = makeTempDir(suffix)
        const lib = new ThreadLib()
        let store
        try {
          store = await lib.open(dir)
          store.close()

          // push() must throw
          let pushThrew = false
          try {
            await store.push(input)
          } catch {
            pushThrew = true
          }
          if (!pushThrew) return false

          // pushBatch() must throw
          let batchThrew = false
          try {
            await store.pushBatch([input])
          } catch {
            batchThrew = true
          }
          if (!batchThrew) return false

          // peek() must throw
          let peekThrew = false
          try {
            await store.peek({ lastEventId: 0 })
          } catch {
            peekThrew = true
          }
          if (!peekThrew) return false

          return true
        } finally {
          await rm(dir, { recursive: true, force: true })
        }
      }),
      { numRuns: 20 }
    )
  })
})

// ── Property 13: lib 错误不调用 process.exit() ───────────────────────────────

/**
 * Validates: Requirements 9.2
 *
 * For any error-triggering operations (init on existing path, close then operate),
 * lib throws ThreadError, does NOT call process.exit(), does NOT write stdout/stderr.
 */
describe('Property 13: lib 错误不调用 process.exit()', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('init 已存在路径：throw ThreadError，不调用 process.exit()，不写 stdout/stderr', async () => {
    await fc.assert(
      fc.asyncProperty(arbSuffix, async (suffix) => {
        const dir = makeTempDir(suffix)
        const lib = new ThreadLib()
        let store

        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as () => never)
        const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
        const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

        try {
          store = await lib.init(dir)
          store.close()

          let threw = false
          let isThreadError = false
          try {
            const s2 = await lib.init(dir)
            s2.close()
          } catch (err) {
            threw = true
            isThreadError = err instanceof ThreadError && err.code === 'THREAD_ALREADY_EXISTS'
          }

          if (!threw || !isThreadError) return false
          if (exitSpy.mock.calls.length > 0) return false
          if (stdoutSpy.mock.calls.length > 0) return false
          if (stderrSpy.mock.calls.length > 0) return false

          return true
        } finally {
          vi.restoreAllMocks()
          if (store && !store['closed']) store.close()
          await rm(dir, { recursive: true, force: true })
        }
      }),
      { numRuns: 20 }
    )
  })

  it('close() 后操作：throw ThreadError，不调用 process.exit()，不写 stdout/stderr', async () => {
    await fc.assert(
      fc.asyncProperty(arbSuffix, arbEventInput, async (suffix, input) => {
        const dir = makeTempDir(suffix)
        const lib = new ThreadLib()
        let store

        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as () => never)
        const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
        const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

        try {
          store = await lib.open(dir)
          store.close()

          let threw = false
          let isThreadError = false
          try {
            await store.push(input)
          } catch (err) {
            threw = true
            isThreadError = err instanceof ThreadError && err.code === 'THREAD_CLOSED'
          }

          if (!threw || !isThreadError) return false
          if (exitSpy.mock.calls.length > 0) return false
          if (stdoutSpy.mock.calls.length > 0) return false
          if (stderrSpy.mock.calls.length > 0) return false

          return true
        } finally {
          vi.restoreAllMocks()
          await rm(dir, { recursive: true, force: true })
        }
      }),
      { numRuns: 20 }
    )
  })
})
