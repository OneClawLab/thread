/**
 * Unit tests for `thread pop` command
 * Validates: Requirements 3.2, 3.6, 3.7, 3.8
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { Command } from 'commander';
import { register } from '../../src/commands/pop.js';
import { createTestThread } from '../helpers/thread-helpers.js';
import type { TestThread } from '../helpers/thread-helpers.js';
import { insertEvent, insertSubscription, getConsumerProgress } from '../../src/db/queries.js';

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  register(program);
  return program;
}

async function runPop(args: string[]): Promise<string> {
  const chunks: string[] = [];
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  });

  const program = makeProgram();
  await program.parseAsync(['node', 'thread', 'pop', ...args]);

  stdoutSpy.mockRestore();
  return chunks.join('');
}

let thread: TestThread;

beforeEach(() => {
  thread = createTestThread();
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  thread.cleanup();
});

// ─── Normal consumption (requirement 3.5) ───────────────────────────────────

describe('thread pop — normal consumption', () => {
  it('outputs pushed events as NDJSON to stdout', async () => {
    insertSubscription(thread.db, { consumer_id: 'worker-1', handler_cmd: 'echo', filter: null });
    insertEvent(thread.db, { source: 'src', type: 'msg', content: 'hello' });
    insertEvent(thread.db, { source: 'src', type: 'msg', content: 'world' });

    const output = await runPop([
      '--thread', thread.dir,
      '--consumer', 'worker-1',
      '--last-event-id', '0',
    ]);

    const lines = output.trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(2);

    const first = JSON.parse(lines[0]!) as { id: number; content: string };
    const second = JSON.parse(lines[1]!) as { id: number; content: string };
    expect(first.content).toBe('hello');
    expect(second.content).toBe('world');
    expect(first.id).toBeLessThan(second.id);
  });

  it('updates consumer_progress with last-event-id (requirement 3.3)', async () => {
    insertSubscription(thread.db, { consumer_id: 'worker-1', handler_cmd: 'echo', filter: null });
    insertEvent(thread.db, { source: 'src', type: 'msg', content: 'data' });

    await runPop([
      '--thread', thread.dir,
      '--consumer', 'worker-1',
      '--last-event-id', '5',
    ]);

    const progress = getConsumerProgress(thread.db, 'worker-1');
    expect(progress).not.toBeNull();
    expect(progress!.last_acked_id).toBe(5);
  });
});

// ─── Empty result (requirement 3.6) ─────────────────────────────────────────

describe('thread pop — empty result', () => {
  it('outputs nothing when no new events exist', async () => {
    insertSubscription(thread.db, { consumer_id: 'worker-1', handler_cmd: 'echo', filter: null });
    insertEvent(thread.db, { source: 'src', type: 'msg', content: 'old' });

    // last-event-id=1 means we already processed id=1
    const output = await runPop([
      '--thread', thread.dir,
      '--consumer', 'worker-1',
      '--last-event-id', '1',
    ]);

    expect(output).toBe('');
  });

  it('outputs nothing when no events exist at all', async () => {
    insertSubscription(thread.db, { consumer_id: 'worker-1', handler_cmd: 'echo', filter: null });

    const output = await runPop([
      '--thread', thread.dir,
      '--consumer', 'worker-1',
      '--last-event-id', '0',
    ]);

    expect(output).toBe('');
  });
});

// ─── Consumer not found (requirement 3.2) ───────────────────────────────────

describe('thread pop — consumer not found', () => {
  it('exits with code 1 when consumer does not exist', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null) => {
      throw new Error(`process.exit(${_code})`);
    });

    await expect(runPop([
      '--thread', thread.dir,
      '--consumer', 'nonexistent',
      '--last-event-id', '0',
    ])).rejects.toThrow('process.exit(1)');

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('writes error message to stderr when consumer does not exist', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

    try {
      await runPop([
        '--thread', thread.dir,
        '--consumer', 'nonexistent',
        '--last-event-id', '0',
      ]);
    } catch { /* expected */ }

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Error:'));
  });
});

// ─── Filter (requirement 3.7) ────────────────────────────────────────────────

describe('thread pop — filter', () => {
  it('only returns events matching the filter', async () => {
    insertSubscription(thread.db, {
      consumer_id: 'filtered-worker',
      handler_cmd: 'echo',
      filter: "type = 'important'",
    });
    insertEvent(thread.db, { source: 'src', type: 'important', content: 'keep me' });
    insertEvent(thread.db, { source: 'src', type: 'noise', content: 'ignore me' });
    insertEvent(thread.db, { source: 'src', type: 'important', content: 'keep me too' });

    const output = await runPop([
      '--thread', thread.dir,
      '--consumer', 'filtered-worker',
      '--last-event-id', '0',
    ]);

    const lines = output.trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(2);

    const events = lines.map(l => JSON.parse(l) as { type: string; content: string });
    expect(events.every(e => e.type === 'important')).toBe(true);
    expect(events[0]!.content).toBe('keep me');
    expect(events[1]!.content).toBe('keep me too');
  });

  it('returns all events when filter is null (requirement 3.7)', async () => {
    insertSubscription(thread.db, { consumer_id: 'all-worker', handler_cmd: 'echo', filter: null });
    insertEvent(thread.db, { source: 'src', type: 'a', content: 'c1' });
    insertEvent(thread.db, { source: 'src', type: 'b', content: 'c2' });

    const output = await runPop([
      '--thread', thread.dir,
      '--consumer', 'all-worker',
      '--last-event-id', '0',
    ]);

    const lines = output.trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(2);
  });
});

// ─── last-event-id=0 consumes from beginning (requirement 3.8) ──────────────

describe('thread pop — last-event-id=0', () => {
  it('returns all events starting from id=1 when last-event-id=0', async () => {
    insertSubscription(thread.db, { consumer_id: 'worker-1', handler_cmd: 'echo', filter: null });
    insertEvent(thread.db, { source: 'src', type: 'msg', content: 'first' });
    insertEvent(thread.db, { source: 'src', type: 'msg', content: 'second' });
    insertEvent(thread.db, { source: 'src', type: 'msg', content: 'third' });

    const output = await runPop([
      '--thread', thread.dir,
      '--consumer', 'worker-1',
      '--last-event-id', '0',
    ]);

    const lines = output.trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(3);

    const events = lines.map(l => JSON.parse(l) as { id: number; content: string });
    expect(events[0]!.id).toBe(1);
    expect(events[0]!.content).toBe('first');
    expect(events[2]!.content).toBe('third');
  });
});
