import { describe, it, expect, afterEach } from 'vitest'
import * as os from 'node:os'
import { ThreadLib } from '../../src/lib/thread-lib.js'
import { ThreadError } from '../../src/lib/types.js'
import { path } from '../../src/repo-utils/path.js'
import * as fs from '../../src/repo-utils/fs.js'

const lib = new ThreadLib()

let tmpDir: string

afterEach(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(path.toPosixPath(os.tmpdir()), 'thread-lib-test-'))
}

// ── Test cases ────────────────────────────────────────────────────────────────

describe('open()', () => {
  it('auto-initializes a non-existent path (creates events.db, events.jsonl, run/, logs/)', async () => {
    tmpDir = makeTempDir()
    const threadPath = path.join(tmpDir, 'new-thread')

    const store = await lib.open(threadPath)
    store.close()

    expect(fs.existsSync(path.join(threadPath, 'events.db'))).toBe(true)
    expect(fs.existsSync(path.join(threadPath, 'events.jsonl'))).toBe(true)
    expect(fs.existsSync(path.join(threadPath, 'run'))).toBe(true)
    expect(fs.existsSync(path.join(threadPath, 'logs'))).toBe(true)
  })

  it('does NOT destroy existing data when opening an already-existing thread', async () => {
    tmpDir = makeTempDir()
    const threadPath = path.join(tmpDir, 'existing-thread')

    // First open: create and write an event
    const store1 = await lib.open(threadPath)
    await store1.push({ source: 'test', type: 'message', content: 'hello' })
    store1.close()

    // Second open: should not destroy existing data
    const store2 = await lib.open(threadPath)
    const events = await store2.peek({ lastEventId: 0 })
    store2.close()

    expect(events).toHaveLength(1)
    expect(events[0]?.content).toBe('hello')
  })
})

describe('init()', () => {
  it('throws ThreadError with code THREAD_ALREADY_EXISTS on an already-existing thread', async () => {
    tmpDir = makeTempDir()
    const threadPath = path.join(tmpDir, 'init-thread')

    // First init: should succeed
    const store = await lib.init(threadPath)
    store.close()

    // Second init: should throw
    await expect(lib.init(threadPath)).rejects.toSatisfy(
      (err: unknown) => err instanceof ThreadError && err.code === 'THREAD_ALREADY_EXISTS'
    )
  })
})

describe('exists()', () => {
  it('returns false before init and true after init', async () => {
    tmpDir = makeTempDir()
    const threadPath = path.join(tmpDir, 'exists-thread')

    expect(await lib.exists(threadPath)).toBe(false)

    const store = await lib.init(threadPath)
    store.close()

    expect(await lib.exists(threadPath)).toBe(true)
  })
})

describe('destroy()', () => {
  it('deletes the directory, then exists() returns false', async () => {
    tmpDir = makeTempDir()
    const threadPath = path.join(tmpDir, 'destroy-thread')

    const store = await lib.init(threadPath)
    store.close()

    expect(await lib.exists(threadPath)).toBe(true)

    await lib.destroy(threadPath)

    expect(await lib.exists(threadPath)).toBe(false)
    expect(fs.existsSync(threadPath)).toBe(false)
  })

  it('does NOT throw on a non-existent path (idempotent)', async () => {
    tmpDir = makeTempDir()
    const nonExistentPath = path.join(tmpDir, 'does-not-exist')

    await expect(lib.destroy(nonExistentPath)).resolves.toBeUndefined()
  })
})
