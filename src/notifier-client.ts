import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Logger } from './logger.js';

const execFileAsync = promisify(execFile);
const IS_WIN32 = process.platform === 'win32';

/**
 * Generate a notifier task-id slug from a thread directory path.
 *
 * Algorithm:
 *   1. Replace all non-alphanumeric characters with '-'
 *   2. If length > 40: take first 32 chars + '-' + sha1(threadDir).slice(0, 6)
 */
export function buildTaskId(threadDir: string): string {
  const slug = threadDir.replace(/[^a-zA-Z0-9]/g, '-');
  if (slug.length > 40) {
    const hash = createHash('sha1').update(threadDir).digest('hex');
    return `dispatch-${slug.slice(0, 32)}-${hash.slice(0, 6)}`;
  }
  return `dispatch-${slug}`;
}

/**
 * Schedule a dispatch via notifier CLI.
 * Exit codes 0 and 1 (task already exists) are both treated as success.
 * Any other exit code is logged as a warning but does NOT fail the caller.
 */
export async function scheduleDispatch(
  threadDir: string,
  source: string,
  logger?: Logger
): Promise<void> {
  const taskId = buildTaskId(threadDir);
  const args = [
    'task', 'add',
    '--author', source,
    '--task-id', taskId,
    '--command', `thread dispatch --thread ${threadDir}`,
  ];

  try {
    await execFileAsync('notifier', args, {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      shell: IS_WIN32,
    });
  } catch (err: unknown) {
    // execFile rejects on non-zero exit; check if it's exit code 1 (task exists)
    const exitCode = (err as { code?: number }).code;
    if (exitCode === 1) {
      // Task already queued — this is expected and fine
      return;
    }
    // Any other error: log warning but don't propagate
    const msg = err instanceof Error ? err.message : String(err);
    logger?.warn(`notifier dispatch schedule failed (non-fatal): ${msg}`);
  }
}
