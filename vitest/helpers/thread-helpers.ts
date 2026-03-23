import * as nodeFs from 'node:fs';
import * as os from 'node:os';
import { path } from '../../src/repo-utils/path.js';
import * as fs from '../../src/repo-utils/fs.js';
import { openDb, initSchema } from '../../src/db/init.js';
import type Database from 'better-sqlite3';

export interface TestThread {
  dir: string;
  db: Database.Database;
  cleanup: () => void;
}

/**
 * Create a temporary thread directory with initialized DB for testing.
 * Automatically cleans up on test teardown.
 */
export function createTestThread(): TestThread {
  const dir = fs.mkdtempSync(path.join(path.toPosixPath(os.tmpdir()), 'thread-test-'));
  fs.mkdirSync(path.join(dir, 'run'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), '', 'utf8');

  const db = openDb(dir);
  initSchema(db);

  return {
    dir,
    db,
    cleanup() {
      try { db.close(); } catch { /* ignore */ }
      nodeFs.rmSync(path.toNative(dir), { recursive: true, force: true });
    },
  };
}
