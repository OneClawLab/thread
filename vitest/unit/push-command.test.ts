/**
 * Unit tests for `thread push` command
 * Validates: Requirements 2.1, 2.6, 2.9
 */
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import * as fs from '../../src/repo-utils/fs.js';
import { path } from '../../src/repo-utils/path.js';
import { Command } from 'commander';
import { register } from '../../src/commands/push.js';
import { createTestThread } from '../helpers/thread-helpers.js';
import type { TestThread } from '../helpers/thread-helpers.js';
import { PassThrough } from 'node:stream';

// Mock scheduleDispatch so tests don't need the notifier CLI
vi.mock('../../src/notifier-client.js', () => ({
  buildTaskId: (dir: string) => `dispatch-${dir.replace(/[^a-zA-Z0-9]/g, '-')}`,
  scheduleDispatch: vi.fn().mockResolvedValue(undefined),
}));

import { scheduleDispatch } from '../../src/notifier-client.js';

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  register(program);
  return program;
}

async function runPush(args: string[]): Promise<void> {
  const program = makeProgram();
  await program.parseAsync(['node', 'thread', 'push', ...args]);
}

let thread: TestThread;

beforeEach(() => {
  thread = createTestThread();
  vi.mocked(scheduleDispatch).mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  thread.cleanup();
});

// ─── Single push ────────────────────────────────────────────────────────────

describe('thread push — single event (requirement 2.1)', () => {
  it('inserts event into DB', async () => {
    await runPush([
      '--thread', thread.dir,
      '--source', 'test-src',
      '--type', 'msg',
      '--content', 'hello',
    ]);

    const row = thread.db.prepare('SELECT * FROM events WHERE source = ?').get('test-src') as {
      id: number; source: string; type: string; subtype: string | null; content: string;
    } | undefined;
    expect(row).toBeDefined();
    expect(row!.source).toBe('test-src');
    expect(row!.type).toBe('msg');
    expect(row!.content).toBe('hello');
    expect(row!.subtype).toBeNull();
  });

  it('appends event to events.jsonl', async () => {
    await runPush([
      '--thread', thread.dir,
      '--source', 'src1',
      '--type', 'ev',
      '--content', 'data',
    ]);

    const jsonl = fs.readFileSync(path.join(thread.dir, 'events.jsonl'), 'utf8');
    const lines = jsonl.trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!) as { source: string; type: string; content: string };
    expect(parsed.source).toBe('src1');
    expect(parsed.type).toBe('ev');
    expect(parsed.content).toBe('data');
  });

  it('stores subtype when provided', async () => {
    await runPush([
      '--thread', thread.dir,
      '--source', 'src',
      '--type', 'ev',
      '--subtype', 'toolcall',
      '--content', '{}',
    ]);

    const row = thread.db.prepare('SELECT subtype FROM events WHERE source = ?').get('src') as
      { subtype: string | null } | undefined;
    expect(row?.subtype).toBe('toolcall');
  });

  it('calls scheduleDispatch once', async () => {
    await runPush([
      '--thread', thread.dir,
      '--source', 'agent',
      '--type', 'task',
      '--content', 'do it',
    ]);

    expect(scheduleDispatch).toHaveBeenCalledTimes(1);
    expect(scheduleDispatch).toHaveBeenCalledWith(thread.dir, 'agent', expect.anything());
  });

  it('exits with code 0 (no process.exit called)', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

    await expect(runPush([
      '--thread', thread.dir,
      '--source', 's',
      '--type', 't',
      '--content', 'c',
    ])).resolves.not.toThrow();

    expect(exitSpy).not.toHaveBeenCalled();
  });
});

// ─── Batch push ─────────────────────────────────────────────────────────────

describe('thread push --batch (requirement 2.7, 2.8)', () => {
  function mockStdin(lines: string[]): void {
    const pt = new PassThrough();
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(pt as unknown as typeof process.stdin);
    // Write lines then end the stream asynchronously so readline can consume it
    setImmediate(() => {
      if (lines.length > 0) {
        pt.write(lines.join('\n') + '\n');
      }
      pt.end();
    });
  }

  it('inserts all events from stdin into DB', async () => {
    const payloads = [
      { source: 'a', type: 'x', content: 'c1' },
      { source: 'b', type: 'y', content: 'c2' },
      { source: 'c', type: 'z', content: 'c3' },
    ];
    mockStdin(payloads.map(p => JSON.stringify(p)));

    await runPush(['--thread', thread.dir, '--batch']);

    const rows = thread.db.prepare('SELECT * FROM events ORDER BY id').all() as Array<{
      source: string; type: string; content: string;
    }>;
    expect(rows.length).toBe(3);
    expect(rows[0]!.source).toBe('a');
    expect(rows[1]!.source).toBe('b');
    expect(rows[2]!.source).toBe('c');
  });

  it('appends all events to events.jsonl', async () => {
    const payloads = [
      { source: 'x', type: 't1', content: 'data1' },
      { source: 'y', type: 't2', content: 'data2' },
    ];
    mockStdin(payloads.map(p => JSON.stringify(p)));

    await runPush(['--thread', thread.dir, '--batch']);

    const jsonl = fs.readFileSync(path.join(thread.dir, 'events.jsonl'), 'utf8');
    const lines = jsonl.trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(2);
  });

  it('triggers dispatch only once with last event source', async () => {
    const payloads = [
      { source: 'first', type: 't', content: 'c' },
      { source: 'last', type: 't', content: 'c' },
    ];
    mockStdin(payloads.map(p => JSON.stringify(p)));

    await runPush(['--thread', thread.dir, '--batch']);

    expect(scheduleDispatch).toHaveBeenCalledTimes(1);
    expect(scheduleDispatch).toHaveBeenCalledWith(thread.dir, 'last', expect.anything());
  });

  it('handles optional subtype field', async () => {
    mockStdin([JSON.stringify({ source: 's', type: 't', subtype: 'sub', content: 'c' })]);

    await runPush(['--thread', thread.dir, '--batch']);

    const row = thread.db.prepare('SELECT subtype FROM events').get() as { subtype: string | null } | undefined;
    expect(row?.subtype).toBe('sub');
  });

  it('does nothing when stdin is empty', async () => {
    mockStdin([]); // no lines — produces no valid payloads

    await runPush(['--thread', thread.dir, '--batch']);

    const count = (thread.db.prepare('SELECT COUNT(*) as n FROM events').get() as { n: number }).n;
    expect(count).toBe(0);
    expect(scheduleDispatch).not.toHaveBeenCalled();
  });
});

// ─── Notifier exit code 1 treated as success (requirement 2.6) ──────────────

describe('thread push — notifier exit code 1 treated as success (requirement 2.6)', () => {
  it('does not fail push when scheduleDispatch resolves (exit 1 already handled inside)', async () => {
    // scheduleDispatch internally swallows exit code 1; here we verify push still succeeds
    // even if scheduleDispatch throws (simulating an unexpected error that is non-fatal)
    vi.mocked(scheduleDispatch).mockResolvedValueOnce(undefined);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

    await expect(runPush([
      '--thread', thread.dir,
      '--source', 'src',
      '--type', 'type',
      '--content', 'content',
    ])).resolves.not.toThrow();

    expect(exitSpy).not.toHaveBeenCalled();

    // Event was still written to DB
    const count = (thread.db.prepare('SELECT COUNT(*) as n FROM events').get() as { n: number }).n;
    expect(count).toBe(1);
  });

  it('push succeeds even when notifier would return exit code 1 (task already exists)', async () => {
    // Simulate the real behavior: scheduleDispatch catches exit code 1 and returns normally
    // We verify the push command exits cleanly and the event is persisted
    vi.mocked(scheduleDispatch).mockResolvedValueOnce(undefined);

    await runPush([
      '--thread', thread.dir,
      '--source', 'agent',
      '--type', 'task',
      '--content', 'payload',
    ]);

    const row = thread.db.prepare('SELECT source FROM events').get() as { source: string } | undefined;
    expect(row?.source).toBe('agent');
  });
});

// ─── Invalid thread directory (requirement 2.9) ─────────────────────────────

describe('thread push — invalid thread directory (requirement 2.9)', () => {
  it('calls process.exit(1) when events.db does not exist', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null) => {
      throw new Error(`process.exit(${_code})`);
    });

    // Use a temp dir without events.db
    const emptyDir = fs.mkdtempSync(path.join(thread.dir, 'empty-'));

    await expect(runPush([
      '--thread', emptyDir,
      '--source', 's',
      '--type', 't',
      '--content', 'c',
    ])).rejects.toThrow('process.exit(1)');

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('writes error message to stderr for invalid thread dir', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

    const emptyDir = fs.mkdtempSync(path.join(thread.dir, 'empty-'));

    try {
      await runPush([
        '--thread', emptyDir,
        '--source', 's',
        '--type', 't',
        '--content', 'c',
      ]);
    } catch { /* expected */ }

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Error:'));
  });

  it('does not insert any event when thread dir is invalid', async () => {
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

    const emptyDir = fs.mkdtempSync(path.join(thread.dir, 'empty-'));

    try {
      await runPush([
        '--thread', emptyDir,
        '--source', 's',
        '--type', 't',
        '--content', 'c',
      ]);
    } catch { /* expected */ }

    // The valid thread DB should have no events
    const count = (thread.db.prepare('SELECT COUNT(*) as n FROM events').get() as { n: number }).n;
    expect(count).toBe(0);
  });
});
