import { createHash } from 'node:crypto';
import { execCommand } from './repo-utils/os.js';
import type { Logger } from './repo-utils/logger.js';

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
  // notifier executor runs commands via `sh -c`, so keep POSIX-style paths
  // (e.g. /c/Users/...) — do NOT convert to Windows paths here.
  const args = [
    'task', 'add',
    '--author', source,
    '--task-id', taskId,
    '--command', `thread dispatch --thread ${threadDir}`,
  ];

  try {
    await execCommand('notifier', args, 5000);
  } catch (err: unknown) {
    // execCommand rejects on non-zero exit; check if it's exit code 1 (task exists)
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('exited with code 1')) {
      // Task already queued — this is expected and fine
      return;
    }
    // Any other error: log warning but don't propagate
    logger?.warn(`notifier dispatch schedule failed (non-fatal): ${msg}`);
  }
}
