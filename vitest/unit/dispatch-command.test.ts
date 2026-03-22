/**
 * Unit tests for `thread dispatch` command
 * Validates: Requirements 4.3, 4.5, 4.6
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import { Command } from 'commander';
import { createTestThread } from '../helpers/thread-helpers.js';
import type { TestThread } from '../helpers/thread-helpers.js';
import { insertSubscription, insertEvent } from '../../src/db/queries.js';
import { path } from '../../src/repo-utils/path.js';

// Mock child_process at the top level so ESM module namespace is interceptable
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn(() => ({ unref: vi.fn() })),
  };
});

import { spawn } from 'node:child_process';
import { register } from '../../src/commands/dispatch.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  register(program);
  return program;
}

async function runDispatch(args: string[]): Promise<void> {
  const program = makeProgram();
  await program.parseAsync(['node', 'thread', 'dispatch', ...args]);
}

let thread: TestThread;

beforeEach(() => {
  thread = createTestThread();
  vi.mocked(spawn).mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  thread.cleanup();
});

// ─── No subscriptions (requirement 4.1, 4.7) ─────────────────────────────────

describe('thread dispatch — no subscriptions', () => {
  it('exits cleanly with code 0 when there are no subscriptions', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

    await expect(runDispatch(['--thread', thread.dir])).resolves.not.toThrow();

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('does not spawn any process when there are no subscriptions', async () => {
    await runDispatch(['--thread', thread.dir]);

    expect(spawn).not.toHaveBeenCalled();
  });
});

// ─── No unconsumed events (requirement 4.3) ──────────────────────────────────

describe('thread dispatch — no unconsumed events', () => {
  it('does not spawn handler when all events are already consumed', async () => {
    insertSubscription(thread.db, {
      consumer_id: 'worker-1',
      handler_cmd: 'echo done',
      filter: null,
    });
    insertEvent(thread.db, { source: 'src', type: 'msg', content: 'hello' });
    // Mark event as consumed (last_acked_id = 1)
    thread.db.prepare(
      `INSERT INTO consumer_progress (consumer_id, last_acked_id, updated_at)
       VALUES ('worker-1', 1, datetime('now'))`
    ).run();

    await runDispatch(['--thread', thread.dir]);

    expect(spawn).not.toHaveBeenCalled();
  });
});

// ─── Unconsumed events → spawn handler (requirement 4.5) ─────────────────────

describe('thread dispatch — unconsumed events present', () => {
  it('spawns handler_cmd when consumer has unconsumed events', async () => {
    insertSubscription(thread.db, {
      consumer_id: 'worker-1',
      handler_cmd: 'echo handler',
      filter: null,
    });
    insertEvent(thread.db, { source: 'src', type: 'msg', content: 'new event' });

    await runDispatch(['--thread', thread.dir]);

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith('echo handler', [], expect.any(Object));
  });

  it('spawns with shell:true and detached:true', async () => {
    insertSubscription(thread.db, {
      consumer_id: 'worker-2',
      handler_cmd: 'my-handler',
      filter: null,
    });
    insertEvent(thread.db, { source: 'src', type: 'ev', content: 'data' });

    await runDispatch(['--thread', thread.dir]);

    expect(spawn).toHaveBeenCalledWith(
      'my-handler',
      [],
      expect.objectContaining({ shell: true, detached: true })
    );
  });

  it('creates lock file when spawning handler', async () => {
    insertSubscription(thread.db, {
      consumer_id: 'worker-lock',
      handler_cmd: 'echo ok',
      filter: null,
    });
    insertEvent(thread.db, { source: 'src', type: 'ev', content: 'data' });

    await runDispatch(['--thread', thread.dir]);

    const lockPath = path.join(thread.dir, 'run', 'worker-lock.lock');
    expect(fs.existsSync(lockPath)).toBe(true);
  });
});

// ─── Lock already held → skip (requirement 4.6) ──────────────────────────────

describe('thread dispatch — lock already held', () => {
  it('skips consumer when lock file already exists', async () => {
    insertSubscription(thread.db, {
      consumer_id: 'busy-worker',
      handler_cmd: 'echo busy',
      filter: null,
    });
    insertEvent(thread.db, { source: 'src', type: 'msg', content: 'pending' });

    // Pre-create the lock file to simulate a running handler
    const lockPath = path.join(thread.dir, 'run', 'busy-worker.lock');
    fs.writeFileSync(lockPath, '99999');

    await runDispatch(['--thread', thread.dir]);

    expect(spawn).not.toHaveBeenCalled();
  });

  it('spawns for unlocked consumer but skips locked one', async () => {
    insertSubscription(thread.db, {
      consumer_id: 'free-worker',
      handler_cmd: 'echo free',
      filter: null,
    });
    insertSubscription(thread.db, {
      consumer_id: 'locked-worker',
      handler_cmd: 'echo locked',
      filter: null,
    });
    insertEvent(thread.db, { source: 'src', type: 'msg', content: 'event' });

    // Lock only the second consumer
    const lockPath = path.join(thread.dir, 'run', 'locked-worker.lock');
    fs.writeFileSync(lockPath, '99999');

    await runDispatch(['--thread', thread.dir]);

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith('echo free', [], expect.any(Object));
  });
});
