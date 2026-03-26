import { existsSync, mkdirSync, writeFileSync, rm } from '../repo-utils/fs.js'
import { path } from '../repo-utils/path.js'
import { ThreadStore } from './thread-store.js'
import { ThreadError } from './types.js'
import { openDb, initSchema } from './db.js'

export class ThreadLib {
  // ── Task 5.1 ─────────────────────────────────────────────────────────────

  private _initDir(threadPath: string): void {
    mkdirSync(path.join(threadPath, 'run'), { recursive: true })
    mkdirSync(path.join(threadPath, 'logs'), { recursive: true })
    const db = openDb(threadPath)
    initSchema(db)
    db.close()
    const jsonlPath = path.join(threadPath, 'events.jsonl')
    if (!existsSync(jsonlPath)) {
      writeFileSync(jsonlPath, '')
    }
  }

  // ── Task 5.2 ─────────────────────────────────────────────────────────────

  async open(threadPath: string): Promise<ThreadStore> {
    if (!existsSync(path.join(threadPath, 'events.db'))) {
      this._initDir(threadPath)
    }
    const db = openDb(threadPath)
    return new ThreadStore(threadPath, db)
  }

  // ── Task 5.3 ─────────────────────────────────────────────────────────────

  async init(threadPath: string): Promise<ThreadStore> {
    if (existsSync(path.join(threadPath, 'events.db'))) {
      throw new ThreadError('Thread already exists at ' + threadPath, 'THREAD_ALREADY_EXISTS')
    }
    this._initDir(threadPath)
    const db = openDb(threadPath)
    return new ThreadStore(threadPath, db)
  }

  // ── Task 5.4 ─────────────────────────────────────────────────────────────

  async exists(threadPath: string): Promise<boolean> {
    return existsSync(path.join(threadPath, 'events.db'))
  }

  // ── Task 5.5 ─────────────────────────────────────────────────────────────

  async destroy(threadPath: string): Promise<void> {
    if (!existsSync(threadPath)) {
      return
    }
    await rm(threadPath, { recursive: true, force: true })
  }
}
