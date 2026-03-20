/**
 * Unit tests for `thread peek` command
 * Validates: SPEC §6.1 thread peek
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { Command } from 'commander';
import { register } from '../../src/commands/peek.js';
import { createTestThread } from '../helpers/thread-helpers.js';
import type { TestThread } from '../helpers/thread-helpers.js';
import { insertEvent, insertEventsBatch, insertSubscription, getConsumerProgress } from '../../src/db/queries.js';

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  register(program);
  return program;
}

async function runPeek(args: string[]): Promise<string> {
  const chunks: string[] = [];
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  });

  const program = makeProgram();
  await program.parseAsync(['node', 'thread', 'peek', ...args]);

  stdoutSpy.mockRestore();
  return chunks.join('');
}

let thread: TestThread;

beforeEach(() => {
  thread = createTestThread();
});

afterEach(() => {
  vi.restoreAllMocks();
  thread.cleanup();
});

// ─── Basic query ─────────────────────────────────────────────────────────────

describe('thread peek — basic query', () => {
  it('returns all events as NDJSON when last-event-id=0', async () => {
    insertEvent(thread.db, { source: 'src', type: 'msg', content: 'hello' });
    insertEvent(thread.db, { source: 'src', type: 'msg', content: 'world' });

    const output = await runPeek(['--thread', thread.dir, '--last-event-id', '0']);

    const lines = output.trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(2);
    const first = JSON.parse(lines[0]!) as { content: string };
    const second = JSON.parse(lines[1]!) as { content: string };
    expect(first.content).toBe('hello');
    expect(second.content).toBe('world');
  });

  it('returns events with id > last-event-id', async () => {
    insertEventsBatch(thread.db, [
      { source: 'a', type: 'msg', content: '1' },
      { source: 'b', type: 'msg', content: '2' },
      { source: 'c', type: 'msg', content: '3' },
    ]);

    const output = await runPeek(['--thread', thread.dir, '--last-event-id', '2']);

    const lines = output.trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(1);
    const event = JSON.parse(lines[0]!) as { id: number; content: string };
    expect(event.id).toBe(3);
    expect(event.content).toBe('3');
  });

  it('returns empty output when no matching events', async () => {
    insertEvent(thread.db, { source: 'src', type: 'msg', content: 'old' });

    const output = await runPeek(['--thread', thread.dir, '--last-event-id', '1']);

    expect(output).toBe('');
  });

  it('returns empty output when no events exist', async () => {
    const output = await runPeek(['--thread', thread.dir, '--last-event-id', '0']);

    expect(output).toBe('');
  });
});

// ─── Filter ──────────────────────────────────────────────────────────────────

describe('thread peek — filter', () => {
  it('applies --filter to restrict returned events', async () => {
    insertEventsBatch(thread.db, [
      { source: 'a', type: 'message', content: 'keep' },
      { source: 'b', type: 'record', content: 'skip' },
      { source: 'c', type: 'message', content: 'keep too' },
    ]);

    const output = await runPeek([
      '--thread', thread.dir,
      '--last-event-id', '0',
      '--filter', "type = 'message'",
    ]);

    const lines = output.trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(2);
    const events = lines.map(l => JSON.parse(l) as { type: string });
    expect(events.every(e => e.type === 'message')).toBe(true);
  });

  it('returns all events when no --filter is provided', async () => {
    insertEventsBatch(thread.db, [
      { source: 'a', type: 'alpha', content: '1' },
      { source: 'b', type: 'beta', content: '2' },
    ]);

    const output = await runPeek(['--thread', thread.dir, '--last-event-id', '0']);

    const lines = output.trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(2);
  });
});

// ─── Limit ───────────────────────────────────────────────────────────────────

describe('thread peek — limit', () => {
  it('respects --limit option', async () => {
    insertEventsBatch(thread.db, [
      { source: 'a', type: 'msg', content: '1' },
      { source: 'b', type: 'msg', content: '2' },
      { source: 'c', type: 'msg', content: '3' },
    ]);

    const output = await runPeek([
      '--thread', thread.dir,
      '--last-event-id', '0',
      '--limit', '2',
    ]);

    const lines = output.trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(2);
  });
});

// ─── Does NOT update consumer_progress (key difference from pop) ─────────────

describe('thread peek — read-only (no consumer_progress update)', () => {
  it('does not require --consumer and does not update consumer_progress', async () => {
    insertSubscription(thread.db, { consumer_id: 'worker-1', handler_cmd: 'echo', filter: null });
    insertEvent(thread.db, { source: 'src', type: 'msg', content: 'data' });

    await runPeek(['--thread', thread.dir, '--last-event-id', '0']);

    // consumer_progress should remain untouched
    const progress = getConsumerProgress(thread.db, 'worker-1');
    expect(progress).toBeNull();
  });

  it('does not require consumer to be registered in subscriptions', async () => {
    insertEvent(thread.db, { source: 'src', type: 'msg', content: 'data' });

    // No subscriptions at all — peek should still work
    const output = await runPeek(['--thread', thread.dir, '--last-event-id', '0']);

    const lines = output.trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(1);
  });
});

// ─── Invalid thread directory ────────────────────────────────────────────────

describe('thread peek — invalid thread directory', () => {
  it('exits with code 1 for a non-thread directory', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null) => {
      throw new Error(`process.exit(${_code})`);
    });

    await expect(
      runPeek(['--thread', '/tmp/definitely-not-a-thread-dir-xyz', '--last-event-id', '0'])
    ).rejects.toThrow('process.exit(1)');

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
