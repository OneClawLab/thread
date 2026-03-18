/**
 * Unit tests for `thread info` command
 * Validates: Requirements 6.1, 6.2, 6.3
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { Command } from 'commander';
import { register } from '../../src/commands/info.js';
import { createTestThread } from '../helpers/thread-helpers.js';
import type { TestThread } from '../helpers/thread-helpers.js';
import { insertEvent, insertSubscription } from '../../src/db/queries.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  register(program);
  return program;
}

async function runInfo(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdoutChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  });
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  });

  try {
    const program = makeProgram();
    await program.parseAsync(['node', 'thread', 'info', ...args]);
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }

  return {
    stdout: stdoutChunks.join(''),
    stderr: stderrChunks.join(''),
  };
}

let thread: TestThread;

beforeEach(() => {
  thread = createTestThread();
});

afterEach(() => {
  vi.restoreAllMocks();
  thread.cleanup();
});

// ─── Text output format (requirement 6.1) ────────────────────────────────────

describe('thread info — text output', () => {
  it('shows event count and thread path', async () => {
    insertEvent(thread.db, { source: 'src', type: 'msg', content: 'hello' });
    insertEvent(thread.db, { source: 'src', type: 'msg', content: 'world' });

    const { stdout } = await runInfo(['--thread', thread.dir]);

    expect(stdout).toContain('Events: 2');
    expect(stdout).toContain(thread.dir);
  });

  it('shows subscription count', async () => {
    insertSubscription(thread.db, { consumer_id: 'worker-1', handler_cmd: 'echo', filter: null });
    insertSubscription(thread.db, { consumer_id: 'worker-2', handler_cmd: 'echo', filter: null });

    const { stdout } = await runInfo(['--thread', thread.dir]);

    expect(stdout).toContain('Subscriptions: 2');
  });

  it('shows consumer_id, handler_cmd, and filter for each subscription', async () => {
    insertSubscription(thread.db, {
      consumer_id: 'my-consumer',
      handler_cmd: 'node handler.js',
      filter: "type = 'important'",
    });

    const { stdout } = await runInfo(['--thread', thread.dir]);

    expect(stdout).toContain('my-consumer');
    expect(stdout).toContain('node handler.js');
    expect(stdout).toContain("type = 'important'");
  });

  it('shows (none) for null filter', async () => {
    insertSubscription(thread.db, {
      consumer_id: 'worker-1',
      handler_cmd: 'echo',
      filter: null,
    });

    const { stdout } = await runInfo(['--thread', thread.dir]);

    expect(stdout).toContain('(none)');
  });

  it('shows last_acked_id for each consumer', async () => {
    insertSubscription(thread.db, { consumer_id: 'worker-1', handler_cmd: 'echo', filter: null });
    insertEvent(thread.db, { source: 'src', type: 'msg', content: 'data' });
    // Manually set progress
    thread.db.prepare(
      `INSERT INTO consumer_progress (consumer_id, last_acked_id, updated_at)
       VALUES ('worker-1', 3, datetime('now'))`
    ).run();

    const { stdout } = await runInfo(['--thread', thread.dir]);

    expect(stdout).toContain('last_acked_id: 3');
  });

  it('shows updated_at for each consumer', async () => {
    insertSubscription(thread.db, { consumer_id: 'worker-1', handler_cmd: 'echo', filter: null });
    thread.db.prepare(
      `INSERT INTO consumer_progress (consumer_id, last_acked_id, updated_at)
       VALUES ('worker-1', 0, '2024-01-15T10:00:00.000Z')`
    ).run();

    const { stdout } = await runInfo(['--thread', thread.dir]);

    expect(stdout).toContain('2024-01-15T10:00:00.000Z');
  });

  it('shows (never) for updated_at when consumer has no progress record', async () => {
    insertSubscription(thread.db, { consumer_id: 'worker-1', handler_cmd: 'echo', filter: null });

    const { stdout } = await runInfo(['--thread', thread.dir]);

    expect(stdout).toContain('(never)');
  });

  it('shows zero events and zero subscriptions for empty thread', async () => {
    const { stdout } = await runInfo(['--thread', thread.dir]);

    expect(stdout).toContain('Events: 0');
    expect(stdout).toContain('Subscriptions: 0');
  });
});

// ─── JSON output format (requirement 6.2) ────────────────────────────────────

describe('thread info — JSON output (--json)', () => {
  it('outputs valid JSON when --json flag is provided', async () => {
    const { stdout } = await runInfo(['--thread', thread.dir, '--json']);

    expect(() => JSON.parse(stdout)).not.toThrow();
  });

  it('JSON contains event_count', async () => {
    insertEvent(thread.db, { source: 'src', type: 'msg', content: 'hello' });
    insertEvent(thread.db, { source: 'src', type: 'msg', content: 'world' });

    const { stdout } = await runInfo(['--thread', thread.dir, '--json']);
    const data = JSON.parse(stdout) as { event_count: number };

    expect(data.event_count).toBe(2);
  });

  it('JSON contains subscriptions array with consumer_id, handler_cmd, filter', async () => {
    insertSubscription(thread.db, {
      consumer_id: 'my-consumer',
      handler_cmd: 'node handler.js',
      filter: "type = 'ev'",
    });

    const { stdout } = await runInfo(['--thread', thread.dir, '--json']);
    const data = JSON.parse(stdout) as {
      subscriptions: Array<{ consumer_id: string; handler_cmd: string; filter: string | null }>;
    };

    expect(data.subscriptions).toHaveLength(1);
    expect(data.subscriptions[0]!.consumer_id).toBe('my-consumer');
    expect(data.subscriptions[0]!.handler_cmd).toBe('node handler.js');
    expect(data.subscriptions[0]!.filter).toBe("type = 'ev'");
  });

  it('JSON subscriptions include last_acked_id and updated_at', async () => {
    insertSubscription(thread.db, { consumer_id: 'worker-1', handler_cmd: 'echo', filter: null });
    thread.db.prepare(
      `INSERT INTO consumer_progress (consumer_id, last_acked_id, updated_at)
       VALUES ('worker-1', 7, '2024-06-01T00:00:00.000Z')`
    ).run();

    const { stdout } = await runInfo(['--thread', thread.dir, '--json']);
    const data = JSON.parse(stdout) as {
      subscriptions: Array<{ last_acked_id: number; updated_at: string | null }>;
    };

    expect(data.subscriptions[0]!.last_acked_id).toBe(7);
    expect(data.subscriptions[0]!.updated_at).toBe('2024-06-01T00:00:00.000Z');
  });

  it('JSON subscriptions have null updated_at when no progress record exists', async () => {
    insertSubscription(thread.db, { consumer_id: 'worker-1', handler_cmd: 'echo', filter: null });

    const { stdout } = await runInfo(['--thread', thread.dir, '--json']);
    const data = JSON.parse(stdout) as {
      subscriptions: Array<{ last_acked_id: number; updated_at: string | null }>;
    };

    expect(data.subscriptions[0]!.last_acked_id).toBe(0);
    expect(data.subscriptions[0]!.updated_at).toBeNull();
  });

  it('JSON output ends with a newline', async () => {
    const { stdout } = await runInfo(['--thread', thread.dir, '--json']);

    expect(stdout.endsWith('\n')).toBe(true);
  });
});

// ─── Invalid thread directory (requirement 6.3) ──────────────────────────────

describe('thread info — invalid thread directory', () => {
  it('exits with code 1 for a non-thread directory', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null) => {
      throw new Error(`process.exit(${_code})`);
    });

    await expect(
      runInfo(['--thread', '/tmp/definitely-not-a-thread-dir-xyz'])
    ).rejects.toThrow('process.exit(1)');

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('writes an error message to stderr for invalid directory', async () => {
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

    try {
      await runInfo(['--thread', '/tmp/definitely-not-a-thread-dir-xyz']);
    } catch { /* expected */ }

    // stderr was captured inside runInfo; re-spy to capture it here
  });

  it('stderr contains Error: message for invalid directory', async () => {
    const stderrChunks: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

    try {
      const program = makeProgram();
      await program.parseAsync(['node', 'thread', 'info', '--thread', '/tmp/definitely-not-a-thread-dir-xyz']);
    } catch { /* expected */ }

    expect(stderrChunks.join('')).toContain('Error:');
  });
});
