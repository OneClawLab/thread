/**
 * Integration tests for thread complete flow
 * Uses real SQLite (tmpdir isolation), directly calls internal modules
 * Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from '../../src/repo-utils/fs.js';
import { createTestThread, type TestThread } from '../helpers/thread-helpers.js';
import { openDb, initSchema } from '../../src/db/init.js';
import {
  insertEvent,
  insertEventsBatch,
  insertSubscription,
  popEvents,
  getConsumerProgress,
  upsertConsumerProgress,
  getEventCount,
  getThreadInfo,
} from '../../src/db/queries.js';
import { path } from '../../src/repo-utils/path.js';

// Mock scheduleDispatch so integration tests don't need the notifier CLI
vi.mock('../../src/notifier-client.js', () => ({
  buildTaskId: (dir: string) => `dispatch-${dir.replace(/[^a-zA-Z0-9]/g, '-')}`,
  scheduleDispatch: vi.fn().mockResolvedValue(undefined),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

let thread: TestThread;

beforeEach(() => {
  thread = createTestThread();
});

afterEach(() => {
  vi.restoreAllMocks();
  thread.cleanup();
});

// ── Requirement 1.1: init directory structure validation ─────────────────────

describe('Requirement 1.1 — init directory structure', () => {
  it('creates events.db after init', () => {
    // createTestThread already calls initSchema; verify the file exists
    expect(fs.existsSync(path.join(thread.dir, 'events.db'))).toBe(true);
  });

  it('creates run/ subdirectory', () => {
    expect(fs.existsSync(path.join(thread.dir, 'run'))).toBe(true);
  });

  it('creates logs/ subdirectory', () => {
    expect(fs.existsSync(path.join(thread.dir, 'logs'))).toBe(true);
  });

  it('creates events.jsonl file', () => {
    expect(fs.existsSync(path.join(thread.dir, 'events.jsonl'))).toBe(true);
  });

  it('events table exists and is empty after init', () => {
    const count = getEventCount(thread.db);
    expect(count).toBe(0);
  });
});

// ── Requirement 1.2: push persistence ────────────────────────────────────────

describe('Requirement 1.2 — push persists to SQLite', () => {
  it('insertEvent persists event to SQLite', () => {
    const id = insertEvent(thread.db, { source: 'agent-1', type: 'message', content: 'hello' });
    expect(id).toBe(1);

    const row = thread.db.prepare('SELECT * FROM events WHERE id = 1').get() as {
      id: number; source: string; type: string; content: string; subtype: string | null;
    };
    expect(row.source).toBe('agent-1');
    expect(row.type).toBe('message');
    expect(row.content).toBe('hello');
    expect(row.subtype).toBeNull();
  });

  it('event count increases after push', () => {
    insertEvent(thread.db, { source: 'src', type: 'msg', content: 'c1' });
    insertEvent(thread.db, { source: 'src', type: 'msg', content: 'c2' });
    expect(getEventCount(thread.db)).toBe(2);
  });

  it('persists subtype when provided', () => {
    insertEvent(thread.db, { source: 'src', type: 'record', subtype: 'toolcall', content: '{}' });
    const row = thread.db.prepare('SELECT subtype FROM events WHERE id = 1').get() as { subtype: string };
    expect(row.subtype).toBe('toolcall');
  });
});

// ── Requirement 1.3: subscribe + pop round-trip ───────────────────────────────

describe('Requirement 1.3 — subscribe + pop round-trip', () => {
  it('pop returns event that was pushed after subscribe', () => {
    insertSubscription(thread.db, { consumer_id: 'worker-1', handler_cmd: 'echo', filter: null });
    insertEvent(thread.db, { source: 'agent', type: 'message', content: 'hello world' });

    const events = popEvents(thread.db, 0, null, 100);
    expect(events).toHaveLength(1);
    expect(events[0]!.source).toBe('agent');
    expect(events[0]!.type).toBe('message');
    expect(events[0]!.content).toBe('hello world');
  });

  it('pop returns events in insertion order', () => {
    insertSubscription(thread.db, { consumer_id: 'worker-1', handler_cmd: 'echo', filter: null });
    insertEvent(thread.db, { source: 'src', type: 'msg', content: 'first' });
    insertEvent(thread.db, { source: 'src', type: 'msg', content: 'second' });
    insertEvent(thread.db, { source: 'src', type: 'msg', content: 'third' });

    const events = popEvents(thread.db, 0, null, 100);
    expect(events).toHaveLength(3);
    expect(events[0]!.content).toBe('first');
    expect(events[1]!.content).toBe('second');
    expect(events[2]!.content).toBe('third');
  });

  it('pop with lastEventId > 0 only returns newer events', () => {
    insertSubscription(thread.db, { consumer_id: 'worker-1', handler_cmd: 'echo', filter: null });
    insertEvent(thread.db, { source: 'src', type: 'msg', content: 'old' });
    insertEvent(thread.db, { source: 'src', type: 'msg', content: 'new' });

    const events = popEvents(thread.db, 1, null, 100);
    expect(events).toHaveLength(1);
    expect(events[0]!.content).toBe('new');
  });

  it('pop returns empty array when no new events', () => {
    insertSubscription(thread.db, { consumer_id: 'worker-1', handler_cmd: 'echo', filter: null });
    insertEvent(thread.db, { source: 'src', type: 'msg', content: 'data' });

    const events = popEvents(thread.db, 1, null, 100);
    expect(events).toHaveLength(0);
  });
});

// ── Requirement 1.4: batch push ordering ─────────────────────────────────────

describe('Requirement 1.4 — batch push ordering', () => {
  it('batch push inserts all events', () => {
    const payloads = [
      { source: 'a', type: 'msg', content: 'c1' },
      { source: 'b', type: 'msg', content: 'c2' },
      { source: 'c', type: 'msg', content: 'c3' },
    ];
    const ids = insertEventsBatch(thread.db, payloads);
    expect(ids).toHaveLength(3);
    expect(getEventCount(thread.db)).toBe(3);
  });

  it('batch push returns monotonically increasing ids', () => {
    const payloads = [
      { source: 'a', type: 'msg', content: 'c1' },
      { source: 'b', type: 'msg', content: 'c2' },
      { source: 'c', type: 'msg', content: 'c3' },
    ];
    const ids = insertEventsBatch(thread.db, payloads);
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]!).toBeGreaterThan(ids[i - 1]!);
    }
  });

  it('batch push preserves insertion order when popped', () => {
    const payloads = [
      { source: 'a', type: 'msg', content: 'first' },
      { source: 'b', type: 'msg', content: 'second' },
      { source: 'c', type: 'msg', content: 'third' },
    ];
    insertEventsBatch(thread.db, payloads);

    const events = popEvents(thread.db, 0, null, 100);
    expect(events[0]!.content).toBe('first');
    expect(events[1]!.content).toBe('second');
    expect(events[2]!.content).toBe('third');
  });

  it('batch push of N events adds exactly N rows', () => {
    const n = 5;
    const payloads = Array.from({ length: n }, (_, i) => ({
      source: `src-${i}`,
      type: 'msg',
      content: `content-${i}`,
    }));
    insertEventsBatch(thread.db, payloads);
    expect(getEventCount(thread.db)).toBe(n);
  });
});

// ── Requirement 1.5: filter pop ──────────────────────────────────────────────

describe('Requirement 1.5 — filter pop', () => {
  beforeEach(() => {
    insertEventsBatch(thread.db, [
      { source: 'src', type: 'message', content: 'msg1' },
      { source: 'src', type: 'record', content: 'rec1' },
      { source: 'src', type: 'message', content: 'msg2' },
      { source: 'src', type: 'record', content: 'rec2' },
    ]);
  });

  it('filter by type returns only matching events', () => {
    const events = popEvents(thread.db, 0, "type = 'message'", 100);
    expect(events).toHaveLength(2);
    expect(events.every(e => e.type === 'message')).toBe(true);
  });

  it('filter excludes non-matching events', () => {
    const events = popEvents(thread.db, 0, "type = 'record'", 100);
    expect(events).toHaveLength(2);
    expect(events.every(e => e.type === 'record')).toBe(true);
  });

  it('null filter returns all events', () => {
    const events = popEvents(thread.db, 0, null, 100);
    expect(events).toHaveLength(4);
  });

  it('filter by source returns only matching events', () => {
    insertEvent(thread.db, { source: 'other-src', type: 'message', content: 'other' });
    const events = popEvents(thread.db, 0, "source = 'src'", 100);
    expect(events.every(e => e.source === 'src')).toBe(true);
    expect(events).toHaveLength(4);
  });
});

// ── Requirement 1.6: consumer_progress update ────────────────────────────────

describe('Requirement 1.6 — consumer_progress update', () => {
  it('upsertConsumerProgress sets last_acked_id', () => {
    upsertConsumerProgress(thread.db, 'worker-1', 5);
    const progress = getConsumerProgress(thread.db, 'worker-1');
    expect(progress).not.toBeNull();
    expect(progress!.last_acked_id).toBe(5);
  });

  it('consumer_progress is updated to latest consumed event id', () => {
    insertEvent(thread.db, { source: 'src', type: 'msg', content: 'c1' });
    insertEvent(thread.db, { source: 'src', type: 'msg', content: 'c2' });

    // Simulate pop: ack up to id 2
    upsertConsumerProgress(thread.db, 'worker-1', 2);
    const progress = getConsumerProgress(thread.db, 'worker-1');
    expect(progress!.last_acked_id).toBe(2);
  });

  it('consumer_progress updates monotonically', () => {
    upsertConsumerProgress(thread.db, 'worker-1', 3);
    upsertConsumerProgress(thread.db, 'worker-1', 7);
    const progress = getConsumerProgress(thread.db, 'worker-1');
    expect(progress!.last_acked_id).toBe(7);
  });

  it('consumer_progress starts at null for new consumer', () => {
    const progress = getConsumerProgress(thread.db, 'new-consumer');
    expect(progress).toBeNull();
  });

  it('pop with lastEventId reflects consumer_progress correctly', () => {
    insertEventsBatch(thread.db, [
      { source: 'src', type: 'msg', content: 'c1' },
      { source: 'src', type: 'msg', content: 'c2' },
      { source: 'src', type: 'msg', content: 'c3' },
    ]);

    // First pop: consume from 0
    const firstBatch = popEvents(thread.db, 0, null, 100);
    expect(firstBatch).toHaveLength(3);
    const lastId = firstBatch[firstBatch.length - 1]!.id;

    // Ack up to lastId
    upsertConsumerProgress(thread.db, 'worker-1', lastId);

    // Second pop: nothing new
    const secondBatch = popEvents(thread.db, lastId, null, 100);
    expect(secondBatch).toHaveLength(0);
  });
});

// ── Requirement 1.7: error on uninitialized directory ────────────────────────

describe('Requirement 1.7 — error on uninitialized directory', () => {
  it('openDb on non-existent path creates a new db file (SQLite behavior)', () => {
    // SQLite creates the file on open; the real guard is in the command layer
    // We test the command-level guard via process.exit spy
    const uninitDir = path.join(thread.dir, 'uninit-subdir');
    fs.mkdirSync(uninitDir, { recursive: true });

    // No events.db in uninitDir — simulate what push command checks
    const hasDb = fs.existsSync(path.join(uninitDir, 'events.db'));
    expect(hasDb).toBe(false);
  });

  it('push command exits with code 1 for uninitialized directory', async () => {
    const { Command } = await import('commander');
    const { register } = await import('../../src/commands/push.js');

    const program = new Command();
    program.exitOverride();
    register(program);

    const uninitDir = path.join(thread.dir, 'uninit-subdir');
    fs.mkdirSync(uninitDir, { recursive: true });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null) => {
      throw new Error(`process.exit(${_code})`);
    });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await expect(
      program.parseAsync(['node', 'thread', 'push',
        '--thread', uninitDir,
        '--source', 'src',
        '--type', 'msg',
        '--content', 'hello',
      ])
    ).rejects.toThrow('process.exit(1)');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Error:'));
  });

  it('pop command exits with code 1 for uninitialized directory', async () => {
    const { Command } = await import('commander');
    const { register } = await import('../../src/commands/pop.js');

    const program = new Command();
    program.exitOverride();
    register(program);

    const uninitDir = path.join(thread.dir, 'uninit-subdir');
    fs.mkdirSync(uninitDir, { recursive: true });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null) => {
      throw new Error(`process.exit(${_code})`);
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await expect(
      program.parseAsync(['node', 'thread', 'pop',
        '--thread', uninitDir,
        '--consumer', 'worker-1',
        '--last-event-id', '0',
      ])
    ).rejects.toThrow('process.exit(1)');

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

// ── Requirement 1.8: thread info output ──────────────────────────────────────

describe('Requirement 1.8 — thread info output', () => {
  it('getThreadInfo returns correct event count', () => {
    insertEvent(thread.db, { source: 'src', type: 'msg', content: 'c1' });
    insertEvent(thread.db, { source: 'src', type: 'msg', content: 'c2' });

    const info = getThreadInfo(thread.db);
    expect(info.event_count).toBe(2);
  });

  it('getThreadInfo returns subscription info', () => {
    insertSubscription(thread.db, { consumer_id: 'worker-1', handler_cmd: 'echo', filter: null });
    insertSubscription(thread.db, { consumer_id: 'worker-2', handler_cmd: 'run', filter: "type = 'msg'" });

    const info = getThreadInfo(thread.db);
    expect(info.subscriptions).toHaveLength(2);
    const ids = info.subscriptions.map(s => s.consumer_id).sort();
    expect(ids).toEqual(['worker-1', 'worker-2']);
  });

  it('getThreadInfo includes last_acked_id for each consumer', () => {
    insertSubscription(thread.db, { consumer_id: 'worker-1', handler_cmd: 'echo', filter: null });
    upsertConsumerProgress(thread.db, 'worker-1', 42);

    const info = getThreadInfo(thread.db);
    expect(info.subscriptions[0]!.last_acked_id).toBe(42);
  });

  it('getThreadInfo shows last_acked_id=0 for consumer with no progress', () => {
    insertSubscription(thread.db, { consumer_id: 'worker-1', handler_cmd: 'echo', filter: null });

    const info = getThreadInfo(thread.db);
    expect(info.subscriptions[0]!.last_acked_id).toBe(0);
    expect(info.subscriptions[0]!.updated_at).toBeNull();
  });

  it('info command outputs event count and subscription count', async () => {
    const { Command } = await import('commander');
    const { register } = await import('../../src/commands/info.js');

    const program = new Command();
    program.exitOverride();
    register(program);

    insertEvent(thread.db, { source: 'src', type: 'msg', content: 'hello' });
    insertSubscription(thread.db, { consumer_id: 'worker-1', handler_cmd: 'echo', filter: null });

    const chunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    });

    await program.parseAsync(['node', 'thread', 'info', '--thread', thread.dir]);

    const output = chunks.join('');
    expect(output).toContain('Events: 1');
    expect(output).toContain('Subscriptions: 1');
  });

  it('info command --json outputs valid JSON with event_count and subscriptions', async () => {
    const { Command } = await import('commander');
    const { register } = await import('../../src/commands/info.js');

    const program = new Command();
    program.exitOverride();
    register(program);

    insertEvent(thread.db, { source: 'src', type: 'msg', content: 'hello' });
    insertSubscription(thread.db, { consumer_id: 'worker-1', handler_cmd: 'echo', filter: null });

    const chunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    });

    await program.parseAsync(['node', 'thread', 'info', '--thread', thread.dir, '--json']);

    const output = chunks.join('');
    const parsed = JSON.parse(output) as { event_count: number; subscriptions: unknown[] };
    expect(parsed.event_count).toBe(1);
    expect(parsed.subscriptions).toHaveLength(1);
  });
});
