import Database from 'better-sqlite3';
import { path } from '../repo-utils/path.js';

/**
 * Open (or create) the SQLite database at <threadDir>/events.db.
 * Enables WAL mode for concurrent read/write performance.
 */
export function openDb(threadDir: string): Database.Database {
  const dbPath = path.toNative(path.join(threadDir, 'events.db'));
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
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
  `);
}
