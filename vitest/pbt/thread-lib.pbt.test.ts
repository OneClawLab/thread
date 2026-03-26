/**
 * Property-based tests for ThreadLib (open/init/exists/destroy)
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 1.4, 2.2, 2.3, 3.1, 3.2, 4.1, 4.2, 4.3
 */

import { describe, it } from 'vitest'
import * as fc from 'fast-check'
import * as os from 'node:os'
import { ThreadLib } from '../../src/lib/thread-lib.js'
import { ThreadError } from '../../src/lib/types.js'
import { existsSync, rm } from '../../src/repo-utils/fs.js'
import { path } from '../../src/repo-utils/path.js'

// ── Generator ────────────────────────────────────────────────────────────────

let counter = 0

// Each run gets a unique temp dir to avoid collisions across 100 runs
const arbTempDir = fc.string({ minLength: 5, maxLength: 20 })
  .filter(s => /^[a-zA-Z0-9]+$/.test(s))
  .map(suffix => path.join(
    path.toPosixPath(os.tmpdir()),
    `thread-pbt-${suffix}-${Date.now()}-${++counter}`
  ))

// ── Property 1: open() 自动初始化 ────────────────────────────────────────────

/**
 * Validates: Requirements 1.1, 1.3
 *
 * For any non-existent temp path, calling ThreadLib.open() should result in a
 * valid thread (events.db exists) and the returned ThreadStore can successfully
 * execute push() and peek().
 */
describe('Property 1: open() 自动初始化', () => {
  it('对任意不存在的路径，open() 后 events.db 存在且 ThreadStore 可用', async () => {
    await fc.assert(
      fc.asyncProperty(arbTempDir, async (dir) => {
        const lib = new ThreadLib()
        let store
        try {
          store = await lib.open(dir)

          // events.db must exist after open
          const dbExists = existsSync(path.join(dir, 'events.db'))
          if (!dbExists) return false

          // push() and peek() must work
          const event = await store.push({ source: 'test', type: 'message', content: 'hello' })
          if (!event.id || event.id <= 0) return false

          const events = await store.peek({ lastEventId: 0 })
          if (events.length !== 1) return false
          if (events[0]!.content !== 'hello') return false

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

// ── Property 2: open() 幂等性 ────────────────────────────────────────────────

/**
 * Validates: Requirements 1.2, 1.4
 *
 * For any already-initialized thread path, multiple calls to ThreadLib.open()
 * should all succeed, and the event count after each open should match what was
 * written after the first open (data not destroyed).
 */
describe('Property 2: open() 幂等性', () => {
  it('对已初始化的 thread 多次 open()，数据不被破坏', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbTempDir,
        fc.integer({ min: 1, max: 5 }),
        async (dir, extraOpens) => {
          const lib = new ThreadLib()
          let store1
          try {
            // First open + write some events
            store1 = await lib.open(dir)
            await store1.push({ source: 'src', type: 'message', content: 'event1' })
            await store1.push({ source: 'src', type: 'record', content: 'event2' })
            store1.close()

            // Multiple subsequent opens must not destroy data
            for (let i = 0; i < extraOpens; i++) {
              const storeN = await lib.open(dir)
              try {
                const events = await storeN.peek({ lastEventId: 0 })
                if (events.length !== 2) return false
              } finally {
                storeN.close()
              }
            }

            return true
          } finally {
            if (store1 && !store1['closed']) store1.close()
            await rm(dir, { recursive: true, force: true })
          }
        }
      ),
      { numRuns: 20 }
    )
  })
})

// ── Property 3: init() 严格新建 ──────────────────────────────────────────────

/**
 * Validates: Requirements 2.2, 2.3
 *
 * For any already-initialized thread path, calling ThreadLib.init() should
 * throw ThreadError with error.code === 'THREAD_ALREADY_EXISTS', and the
 * existing event count should remain unchanged.
 */
describe('Property 3: init() 严格新建', () => {
  it('对已初始化的 thread 调用 init()，抛出 THREAD_ALREADY_EXISTS 且数据不变', async () => {
    await fc.assert(
      fc.asyncProperty(arbTempDir, async (dir) => {
        const lib = new ThreadLib()
        let store
        try {
          // Initialize and write one event
          store = await lib.init(dir)
          await store.push({ source: 'src', type: 'message', content: 'original' })
          store.close()

          // Second init() must throw THREAD_ALREADY_EXISTS
          let threw = false
          let correctCode = false
          try {
            const store2 = await lib.init(dir)
            store2.close()
          } catch (err) {
            threw = true
            if (err instanceof ThreadError && err.code === 'THREAD_ALREADY_EXISTS') {
              correctCode = true
            }
          }

          if (!threw || !correctCode) return false

          // Existing data must be unchanged
          const storeCheck = await lib.open(dir)
          try {
            const events = await storeCheck.peek({ lastEventId: 0 })
            if (events.length !== 1) return false
            if (events[0]!.content !== 'original') return false
          } finally {
            storeCheck.close()
          }

          return true
        } finally {
          if (store && !store['closed']) store.close()
          await rm(dir, { recursive: true, force: true })
        }
      }),
      { numRuns: 20 }
    )
  })
})

// ── Property 4: exists() 正确反映 thread 状态 ────────────────────────────────

/**
 * Validates: Requirements 3.1, 3.2, 4.3
 *
 * For any path: exists() returns false before init, true after init,
 * false after destroy, and false for never-initialized paths.
 */
describe('Property 4: exists() 正确反映 thread 状态', () => {
  it('exists() 在 init 前为 false，init 后为 true，destroy 后为 false', async () => {
    await fc.assert(
      fc.asyncProperty(arbTempDir, async (dir) => {
        const lib = new ThreadLib()
        let store
        try {
          // Before init: must be false
          if (await lib.exists(dir)) return false

          // After init: must be true
          store = await lib.init(dir)
          store.close()
          if (!(await lib.exists(dir))) return false

          // After destroy: must be false
          await lib.destroy(dir)
          if (await lib.exists(dir)) return false

          return true
        } finally {
          if (store && !store['closed']) store.close()
          await rm(dir, { recursive: true, force: true })
        }
      }),
      { numRuns: 20 }
    )
  })

  it('从未初始化的路径 exists() 返回 false', async () => {
    await fc.assert(
      fc.asyncProperty(arbTempDir, async (dir) => {
        const lib = new ThreadLib()
        // dir was never created — must return false
        return !(await lib.exists(dir))
      }),
      { numRuns: 20 }
    )
  })
})

// ── Property 5: destroy() round-trip ─────────────────────────────────────────

/**
 * Validates: Requirements 4.1, 4.2
 *
 * For any initialized thread path, after destroy() exists() returns false.
 * For any non-existent path, destroy() does not throw.
 */
describe('Property 5: destroy() round-trip', () => {
  it('destroy() 后 exists() 返回 false', async () => {
    await fc.assert(
      fc.asyncProperty(arbTempDir, async (dir) => {
        const lib = new ThreadLib()
        let store
        try {
          store = await lib.init(dir)
          store.close()

          await lib.destroy(dir)
          return !(await lib.exists(dir))
        } finally {
          if (store && !store['closed']) store.close()
          await rm(dir, { recursive: true, force: true })
        }
      }),
      { numRuns: 20 }
    )
  })

  it('对不存在的路径调用 destroy() 不抛出错误（幂等）', async () => {
    await fc.assert(
      fc.asyncProperty(arbTempDir, async (dir) => {
        const lib = new ThreadLib()
        // dir was never created
        try {
          await lib.destroy(dir)
          return true
        } catch {
          return false
        }
      }),
      { numRuns: 20 }
    )
  })
})
