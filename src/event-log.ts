import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Event } from './types.js';

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
    const content = fs.readFileSync(filePath, 'utf8');
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
    fs.renameSync(jsonlPath, rotatedPath);
    fs.writeFileSync(jsonlPath, '', 'utf8');
  }
}

/**
 * Append a single event as a JSON line to events.jsonl.
 * Checks rotation before writing.
 */
export function appendEventLog(threadDir: string, event: Event): void {
  rotateIfNeeded(threadDir);
  const jsonlPath = path.join(threadDir, 'events.jsonl');
  fs.appendFileSync(jsonlPath, JSON.stringify(event) + '\n', 'utf8');
}

/**
 * Append multiple events to events.jsonl in one call.
 * Checks rotation once before writing the batch.
 */
export function appendEventsBatch(threadDir: string, events: Event[]): void {
  if (events.length === 0) return;
  rotateIfNeeded(threadDir);
  const jsonlPath = path.join(threadDir, 'events.jsonl');
  const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  fs.appendFileSync(jsonlPath, lines, 'utf8');
}
