import Database from 'better-sqlite3'
import type { ThreadEvent, ThreadEventInput, PeekOptions } from './types.js'
import { ThreadError } from './types.js'
import { insertEvent, insertEventsBatch, peekEvents } from './db.js'
import { appendEventLog, appendEventsBatch } from './event-log.js'

export class ThreadStore {
  readonly threadPath: string
  private db: Database.Database
  private closed = false

  constructor(threadPath: string, db: Database.Database) {
    this.threadPath = threadPath
    this.db = db
  }

  async push(event: ThreadEventInput): Promise<ThreadEvent> {
    if (this.closed) {
      throw new ThreadError('ThreadStore is closed', 'THREAD_CLOSED')
    }
    const id = insertEvent(this.db, event)
    const threadEvent: ThreadEvent = {
      ...event,
      id,
      created_at: new Date().toISOString(),
      subtype: event.subtype ?? null,
    }
    appendEventLog(this.threadPath, threadEvent)
    return threadEvent
  }

  async pushBatch(events: ThreadEventInput[]): Promise<ThreadEvent[]> {
    if (this.closed) {
      throw new ThreadError('ThreadStore is closed', 'THREAD_CLOSED')
    }
    if (events.length === 0) {
      return []
    }
    const ids = insertEventsBatch(this.db, events)
    const now = new Date().toISOString()
    const threadEvents: ThreadEvent[] = events.map((event, i) => ({
      ...event,
      id: ids[i]!,
      created_at: now,
      subtype: event.subtype ?? null,
    }))
    appendEventsBatch(this.threadPath, threadEvents)
    return threadEvents
  }

  async peek(opts: PeekOptions): Promise<ThreadEvent[]> {
    if (this.closed) {
      throw new ThreadError('ThreadStore is closed', 'THREAD_CLOSED')
    }
    return peekEvents(this.db, opts.lastEventId, opts.filter ?? null, opts.limit ?? 100)
  }

  close(): void {
    if (this.closed) {
      return
    }
    this.db.close()
    this.closed = true
  }
}
