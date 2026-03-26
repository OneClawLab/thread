import { readFileSync, renameSync, writeFileSync, appendFileSync } from '../repo-utils/fs.js';
import { path } from '../repo-utils/path.js';
import type { ThreadEvent } from './types.js';

const JSONL_MAX_LINES = 10000;

function formatRotationTimestamp(date: Date): string {
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  const Y = date.getUTCFullYear();
  const M = pad(date.getUTCMonth() + 1);
  const D = pad(date.getUTCDate());
  const h = pad(date.getUTCHours());
  const m = pad(date.getUTCMinutes());
  const s = pad(date.getUTCSeconds());
  return `${Y}${M}${D}-${h}${m}${s}`;
}

function countLines(filePath: string): number {
  try {
    const content = readFileSync(filePath, 'utf8');
    if (content.length === 0) return 0;
    const lines = content.split('\n');
    return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
}

/**
 * Check line count and rotate events.jsonl if it exceeds JSONL_MAX_LINES.
 * Old file is renamed to events-<YYYYMMDD-HHmmss>.jsonl.
 */
export function rotateIfNeeded(threadDir: string): void {
  const jsonlPath = path.join(threadDir, 'events.jsonl');
  const lineCount = countLines(jsonlPath);
  if (lineCount > JSONL_MAX_LINES) {
    const ts = formatRotationTimestamp(new Date());
    const rotatedPath = path.join(threadDir, `events-${ts}.jsonl`);
    renameSync(jsonlPath, rotatedPath);
    writeFileSync(jsonlPath, '', 'utf8');
  }
}

/**
 * Append a single event as a JSON line to events.jsonl.
 * Checks rotation before writing.
 */
export function appendEventLog(threadDir: string, event: ThreadEvent): void {
  rotateIfNeeded(threadDir);
  const jsonlPath = path.join(threadDir, 'events.jsonl');
  appendFileSync(jsonlPath, JSON.stringify(event) + '\n', 'utf8');
}

/**
 * Append multiple events to events.jsonl in one call.
 * Checks rotation once before writing the batch.
 */
export function appendEventsBatch(threadDir: string, events: ThreadEvent[]): void {
  if (events.length === 0) return;
  rotateIfNeeded(threadDir);
  const jsonlPath = path.join(threadDir, 'events.jsonl');
  const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  appendFileSync(jsonlPath, lines, 'utf8');
}
