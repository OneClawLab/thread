import Database from 'better-sqlite3'
import { path } from '../repo-utils/path.js'
import type { ThreadEventInput, ThreadEvent } from './types.js'

// ── Task 2.1: openDb() and initSchema() from src/db/init.ts ─────────────────

/**
 * Open (or create) the SQLite database at <threadDir>/events.db.
 * Enables WAL mode for concurrent read/write performance.
 */
export function openDb(threadDir: string): Database.Database {
  const dbPath = path.toNative(path.join(threadDir, 'events.db'))
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  return db
}

/**
 * Create all tables and indexes if they don't already exist.
 * Safe to call on an already-initialized database (idempotent).
 */
export function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      source     TEXT    NOT NULL,
      type       TEXT    NOT NULL,
      subtype    TEXT,
      content    TEXT    NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_events_source ON events(source);
    CREATE INDEX IF NOT EXISTS idx_events_type   ON events(type);

    CREATE TABLE IF NOT EXISTS subscriptions (
      consumer_id  TEXT NOT NULL,
      handler_cmd  TEXT NOT NULL,
      filter       TEXT,
      PRIMARY KEY (consumer_id)
    );

    CREATE TABLE IF NOT EXISTS consumer_progress (
      consumer_id   TEXT    NOT NULL PRIMARY KEY,
      last_acked_id INTEGER NOT NULL DEFAULT 0,
      updated_at    TEXT    NOT NULL
    );
  `)
}

// ── Task 2.2: insertEvent() and insertEventsBatch() from src/db/queries.ts ──

/**
 * Insert a single event and return its assigned id.
 */
export function insertEvent(db: Database.Database, payload: ThreadEventInput): number {
  const stmt = db.prepare(
    'INSERT INTO events (source, type, subtype, content) VALUES (?, ?, ?, ?)'
  )
  const result = stmt.run(
    payload.source,
    payload.type,
    payload.subtype ?? null,
    payload.content
  )
  return result.lastInsertRowid as number
}

/**
 * Insert multiple events in a single transaction. Returns the list of assigned ids.
 */
export function insertEventsBatch(db: Database.Database, payloads: ThreadEventInput[]): number[] {
  const stmt = db.prepare(
    'INSERT INTO events (source, type, subtype, content) VALUES (?, ?, ?, ?)'
  )
  const ids: number[] = []
  const txn = db.transaction(() => {
    for (const p of payloads) {
      const result = stmt.run(p.source, p.type, p.subtype ?? null, p.content)
      ids.push(result.lastInsertRowid as number)
    }
  })
  txn()
  return ids
}

// ── Task 2.3: peekEvents() — read-only, does NOT update consumer_progress ───

/**
 * Return events with id > lastEventId that match the optional filter,
 * ordered by id ASC, up to `limit` rows.
 * Unlike popEvents() in db/queries.ts, this does NOT update consumer_progress.
 */
export function peekEvents(
  db: Database.Database,
  lastEventId: number,
  filter: string | null,
  limit: number
): ThreadEvent[] {
  const filterClause = filter ? ` AND (${filter})` : ''
  const sql = `
    SELECT id, created_at, source, type, subtype, content
    FROM events
    WHERE id > ?${filterClause}
    ORDER BY id ASC
    LIMIT ?
  `
  return db.prepare(sql).all(lastEventId, limit) as ThreadEvent[]
}
