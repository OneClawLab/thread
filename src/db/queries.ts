import type Database from 'better-sqlite3';
import type { Event, Subscription, ConsumerProgress, PushPayload, ThreadInfo } from '../types.js';

// ── Events ──────────────────────────────────────────────────

/**
 * Insert a single event and return its assigned id.
 */
export function insertEvent(db: Database.Database, payload: PushPayload): number {
  const stmt = db.prepare(
    'INSERT INTO events (source, type, subtype, content) VALUES (?, ?, ?, ?)'
  );
  const result = stmt.run(
    payload.source,
    payload.type,
    payload.subtype ?? null,
    payload.content
  );
  return result.lastInsertRowid as number;
}

/**
 * Insert multiple events in a single transaction. Returns the list of assigned ids.
 */
export function insertEventsBatch(db: Database.Database, payloads: PushPayload[]): number[] {
  const stmt = db.prepare(
    'INSERT INTO events (source, type, subtype, content) VALUES (?, ?, ?, ?)'
  );
  const ids: number[] = [];
  const txn = db.transaction(() => {
    for (const p of payloads) {
      const result = stmt.run(p.source, p.type, p.subtype ?? null, p.content);
      ids.push(result.lastInsertRowid as number);
    }
  });
  txn();
  return ids;
}

/**
 * Return total number of events in the table.
 */
export function getEventCount(db: Database.Database): number {
  const row = db.prepare('SELECT COUNT(*) as cnt FROM events').get() as { cnt: number };
  return row.cnt;
}

// ── Subscriptions ────────────────────────────────────────────

export function getSubscriptions(db: Database.Database): Subscription[] {
  return db.prepare('SELECT consumer_id, handler_cmd, filter FROM subscriptions').all() as Subscription[];
}

export function getSubscription(db: Database.Database, consumerId: string): Subscription | null {
  const row = db
    .prepare('SELECT consumer_id, handler_cmd, filter FROM subscriptions WHERE consumer_id = ?')
    .get(consumerId);
  return (row as Subscription | undefined) ?? null;
}

export function insertSubscription(db: Database.Database, sub: Subscription): void {
  db.prepare(
    'INSERT INTO subscriptions (consumer_id, handler_cmd, filter) VALUES (?, ?, ?)'
  ).run(sub.consumer_id, sub.handler_cmd, sub.filter ?? null);
}

export function deleteSubscription(db: Database.Database, consumerId: string): void {
  db.prepare('DELETE FROM subscriptions WHERE consumer_id = ?').run(consumerId);
}

// ── Consumer Progress ────────────────────────────────────────

export function getConsumerProgress(db: Database.Database, consumerId: string): ConsumerProgress | null {
  const row = db
    .prepare('SELECT consumer_id, last_acked_id, updated_at FROM consumer_progress WHERE consumer_id = ?')
    .get(consumerId);
  return (row as ConsumerProgress | undefined) ?? null;
}

export function upsertConsumerProgress(
  db: Database.Database,
  consumerId: string,
  lastAckedId: number
): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO consumer_progress (consumer_id, last_acked_id, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(consumer_id) DO UPDATE SET
      last_acked_id = excluded.last_acked_id,
      updated_at    = excluded.updated_at
  `).run(consumerId, lastAckedId, now);
}

// ── Pop ──────────────────────────────────────────────────────

/**
 * Return events with id > lastEventId that match the consumer's filter,
 * ordered by id ASC, up to `limit` rows.
 */
export function popEvents(
  db: Database.Database,
  lastEventId: number,
  filter: string | null,
  limit: number
): Event[] {
  const filterClause = filter ? ` AND (${filter})` : '';
  const sql = `
    SELECT id, created_at, source, type, subtype, content
    FROM events
    WHERE id > ?${filterClause}
    ORDER BY id ASC
    LIMIT ?
  `;
  return db.prepare(sql).all(lastEventId, limit) as Event[];
}

/**
 * Check whether there are any unconsumed events for a consumer.
 */
export function hasUnconsumedEvents(
  db: Database.Database,
  lastAckedId: number,
  filter: string | null
): boolean {
  const filterClause = filter ? ` AND (${filter})` : '';
  const sql = `SELECT 1 FROM events WHERE id > ?${filterClause} LIMIT 1`;
  const row = db.prepare(sql).get(lastAckedId);
  return row !== undefined;
}

// ── Thread Info ──────────────────────────────────────────────

export function getThreadInfo(db: Database.Database): ThreadInfo {
  const event_count = getEventCount(db);
  const subs = getSubscriptions(db);
  const subscriptions = subs.map((sub) => {
    const progress = getConsumerProgress(db, sub.consumer_id);
    return {
      ...sub,
      last_acked_id: progress?.last_acked_id ?? 0,
      updated_at: progress?.updated_at ?? null,
    };
  });
  return { event_count, subscriptions };
}
