import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import Database from 'better-sqlite3';
import { openDb, initSchema } from '../../src/db/init.js';

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thread-init-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('openDb', () => {
  it('creates events.db in the given directory', () => {
    const dir = makeTmpDir();
    const db = openDb(dir);
    db.close();
    expect(fs.existsSync(path.join(dir, 'events.db'))).toBe(true);
  });

  it('enables WAL journal mode', () => {
    const dir = makeTmpDir();
    const db = openDb(dir);
    const row = db.pragma('journal_mode', { simple: true });
    db.close();
    expect(row).toBe('wal');
  });

  it('returns a working Database instance', () => {
    const dir = makeTmpDir();
    const db = openDb(dir);
    expect(db).toBeInstanceOf(Database);
    db.close();
  });
});

describe('initSchema', () => {
  it('creates the events table', () => {
    const dir = makeTmpDir();
    const db = openDb(dir);
    initSchema(db);
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='events'")
      .get();
    db.close();
    expect(row).toBeDefined();
  });

  it('creates the subscriptions table', () => {
    const dir = makeTmpDir();
    const db = openDb(dir);
    initSchema(db);
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='subscriptions'")
      .get();
    db.close();
    expect(row).toBeDefined();
  });

  it('creates the consumer_progress table', () => {
    const dir = makeTmpDir();
    const db = openDb(dir);
    initSchema(db);
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='consumer_progress'")
      .get();
    db.close();
    expect(row).toBeDefined();
  });

  it('creates idx_events_source index', () => {
    const dir = makeTmpDir();
    const db = openDb(dir);
    initSchema(db);
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_events_source'")
      .get();
    db.close();
    expect(row).toBeDefined();
  });

  it('creates idx_events_type index', () => {
    const dir = makeTmpDir();
    const db = openDb(dir);
    initSchema(db);
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_events_type'")
      .get();
    db.close();
    expect(row).toBeDefined();
  });

  it('is idempotent — calling twice does not throw', () => {
    const dir = makeTmpDir();
    const db = openDb(dir);
    initSchema(db);
    expect(() => initSchema(db)).not.toThrow();
    db.close();
  });

  it('is idempotent — reopening an existing db and calling initSchema does not throw', () => {
    const dir = makeTmpDir();
    const db1 = openDb(dir);
    initSchema(db1);
    db1.close();

    const db2 = openDb(dir);
    expect(() => initSchema(db2)).not.toThrow();
    db2.close();
  });
});
