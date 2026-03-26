import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as os from 'node:os'
import { ThreadLib } from '../../src/lib/thread-lib.js'
import { ThreadError } from '../../src/lib/types.js'
import type { ThreadStore } from '../../src/lib/thread-store.js'
import { path } from '../../src/repo-utils/path.js'
import * as fs from '../../src/repo-utils/fs.js'

let store: ThreadStore
let tmpDir: string
const lib = new ThreadLib()

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(path.toPosixPath(os.tmpdir()), 'thread-store-test-'))
  store = await lib.open(tmpDir)
})

afterEach(async () => {
  try { store.close() } catch { /* already closed */ }
  await fs.rm(tmpDir, { recursive: true, force: true })
})

// ── Required test cases ───────────────────────────────────────────────────────

describe('push()', () => {
  it('writes an event and it can be read back via peek()', async () => {
    await store.push({ source: 'test', type: 'message', content: 'hello' })
    const events = await store.peek({ lastEventId: 0 })
    expect(events).toHaveLength(1)
    expect(events[0]?.source).toBe('test')
    expect(events[0]?.type).toBe('message')
    expect(events[0]?.content).toBe('hello')
  })

  it('returns a ThreadEvent with positive integer id', async () => {
    const event = await store.push({ source: 'src', type: 'message', content: 'hi' })
    expect(event.id).toBeGreaterThan(0)
    expect(Number.isInteger(event.id)).toBe(true)
  })

  it('returns a ThreadEvent with valid ISO 8601 created_at', async () => {
    const event = await store.push({ source: 'src', type: 'message', content: 'hi' })
    expect(() => new Date(event.created_at)).not.toThrow()
    expect(new Date(event.created_at).toISOString()).toBe(event.created_at)
  })

  it('stores subtype as null when not provided', async () => {
    const event = await store.push({ source: 'src', type: 'message', content: 'hi' })
    expect(event.subtype).toBeNull()
  })
})

describe('pushBatch()', () => {
  it('returns [] for empty array', async () => {
    const result = await store.pushBatch([])
    expect(result).toEqual([])
  })

  it('returns events in order with sequential ids for multiple events', async () => {
    const inputs = [
      { source: 'a', type: 'message' as const, content: '1' },
      { source: 'b', type: 'record' as const, content: '2' },
      { source: 'c', type: 'message' as const, content: '3' },
    ]
    const events = await store.pushBatch(inputs)
    expect(events).toHaveLength(3)
    expect(events[0]?.content).toBe('1')
    expect(events[1]?.content).toBe('2')
    expect(events[2]?.content).toBe('3')
    expect(events[0]!.id).toBeLessThan(events[1]!.id)
    expect(events[1]!.id).toBeLessThan(events[2]!.id)
  })
})

describe('peek()', () => {
  it('only returns events with id > lastEventId', async () => {
    await store.pushBatch([
      { source: 'a', type: 'message', content: '1' },
      { source: 'b', type: 'message', content: '2' },
      { source: 'c', type: 'message', content: '3' },
    ])
    const events = await store.peek({ lastEventId: 1 })
    expect(events.every(e => e.id > 1)).toBe(true)
    expect(events).toHaveLength(2)
  })
})

describe('close()', () => {
  it('calling push() after close() throws ThreadError with code THREAD_CLOSED', async () => {
    store.close()
    await expect(
      store.push({ source: 'src', type: 'message', content: 'hi' })
    ).rejects.toSatisfy((err: unknown) =>
      err instanceof ThreadError && err.code === 'THREAD_CLOSED'
    )
  })

  it('is idempotent — calling twice does not throw', () => {
    store.close()
    expect(() => store.close()).not.toThrow()
  })
})
