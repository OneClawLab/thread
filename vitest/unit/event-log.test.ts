import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { appendEventLog, appendEventsBatch, rotateIfNeeded } from '../../src/event-log.js';
import type { Event } from '../../src/types.js';

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thread-eventlog-test-'));
  fs.writeFileSync(path.join(dir, 'events.jsonl'), '', 'utf8');
  tmpDirs.push(dir);
  return dir;
}

function makeEvent(id: number): Event {
  return { id, created_at: new Date().toISOString(), source: 'test', type: 'msg', subtype: null, content: `content-${id}` };
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('appendEventLog', () => {
  it('appends a single event as a JSON line', () => {
    const dir = makeTmpDir();
    const event = makeEvent(1);
    appendEventLog(dir, event);
    const content = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ id: 1, source: 'test', type: 'msg' });
  });

  it('appends multiple events sequentially', () => {
    const dir = makeTmpDir();
    appendEventLog(dir, makeEvent(1));
    appendEventLog(dir, makeEvent(2));
    appendEventLog(dir, makeEvent(3));
    const lines = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]!).id).toBe(1);
    expect(JSON.parse(lines[2]!).id).toBe(3);
  });

  it('preserves all event fields', () => {
    const dir = makeTmpDir();
    const event: Event = { id: 42, created_at: '2024-01-01T00:00:00.000Z', source: 'src', type: 'typ', subtype: 'sub', content: 'body' };
    appendEventLog(dir, event);
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim());
    expect(parsed).toEqual(event);
  });
});

describe('appendEventsBatch', () => {
  it('appends all events in one call', () => {
    const dir = makeTmpDir();
    const events = [makeEvent(1), makeEvent(2), makeEvent(3)];
    appendEventsBatch(dir, events);
    const lines = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(3);
  });

  it('does nothing for empty array', () => {
    const dir = makeTmpDir();
    appendEventsBatch(dir, []);
    const content = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8');
    expect(content).toBe('');
  });

  it('each line is valid JSON', () => {
    const dir = makeTmpDir();
    appendEventsBatch(dir, [makeEvent(1), makeEvent(2)]);
    const lines = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n');
    expect(() => lines.forEach(l => JSON.parse(l))).not.toThrow();
  });
});

describe('rotateIfNeeded', () => {
  it('does not rotate when line count < 10000', () => {
    const dir = makeTmpDir();
    // Write 9999 lines
    const content = 'x\n'.repeat(9999);
    fs.writeFileSync(path.join(dir, 'events.jsonl'), content, 'utf8');
    rotateIfNeeded(dir);
    // Original file still exists and no rotated file
    expect(fs.existsSync(path.join(dir, 'events.jsonl'))).toBe(true);
    const files = fs.readdirSync(dir).filter(f => f.startsWith('events-'));
    expect(files).toHaveLength(0);
  });

  it('does not rotate when line count == 10000', () => {
    const dir = makeTmpDir();
    const content = 'x\n'.repeat(10000);
    fs.writeFileSync(path.join(dir, 'events.jsonl'), content, 'utf8');
    rotateIfNeeded(dir);
    const files = fs.readdirSync(dir).filter(f => f.startsWith('events-'));
    expect(files).toHaveLength(0);
  });

  it('rotates when line count > 10000', () => {
    const dir = makeTmpDir();
    const content = 'x\n'.repeat(10001);
    fs.writeFileSync(path.join(dir, 'events.jsonl'), content, 'utf8');
    rotateIfNeeded(dir);
    // New empty events.jsonl created
    expect(fs.existsSync(path.join(dir, 'events.jsonl'))).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8')).toBe('');
    // Old file renamed to events-<timestamp>.jsonl
    const rotated = fs.readdirSync(dir).filter(f => f.startsWith('events-') && f.endsWith('.jsonl'));
    expect(rotated).toHaveLength(1);
    expect(rotated[0]).toMatch(/^events-\d{8}-\d{6}\.jsonl$/);
  });

  it('rotated file retains original content', () => {
    const dir = makeTmpDir();
    const content = 'x\n'.repeat(10001);
    fs.writeFileSync(path.join(dir, 'events.jsonl'), content, 'utf8');
    rotateIfNeeded(dir);
    const rotated = fs.readdirSync(dir).find(f => f.startsWith('events-') && f.endsWith('.jsonl'))!;
    const rotatedContent = fs.readFileSync(path.join(dir, rotated), 'utf8');
    expect(rotatedContent).toBe(content);
  });

  it('appendEventLog triggers rotation when file exceeds 10000 lines', () => {
    const dir = makeTmpDir();
    // Pre-fill with 10001 lines to trigger rotation on next append
    fs.writeFileSync(path.join(dir, 'events.jsonl'), 'x\n'.repeat(10001), 'utf8');
    appendEventLog(dir, makeEvent(1));
    // After rotation, new file should have exactly 1 line
    const lines = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    // Rotated file should exist
    const rotated = fs.readdirSync(dir).filter(f => f.startsWith('events-') && f.endsWith('.jsonl'));
    expect(rotated).toHaveLength(1);
  });
});
