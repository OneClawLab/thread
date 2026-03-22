import type { Command } from 'commander';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, writeSync, closeSync, constants } from '../repo-utils/fs.js';
import { path } from '../repo-utils/path.js';
import { openDb } from '../db/init.js';
import { getSubscriptions, getConsumerProgress, hasUnconsumedEvents } from '../db/queries.js';
import { createFileLogger } from '../repo-utils/logger.js';

function assertValidThreadDir(threadDir: string): void {
  if (!existsSync(path.join(threadDir, 'events.db'))) {
    process.stderr.write(
      `Error: ${threadDir} 不是有效的 thread 目录 - 请先运行 thread init ${threadDir}\n`
    );
    process.exit(1);
  }
}

/**
 * Try to acquire an exclusive lock file using O_EXCL atomic creation.
 * Returns true if lock was acquired, false if already held.
 */
function tryLock(lockPath: string): boolean {
  try {
    const fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
    writeSync(fd, String(process.pid));
    closeSync(fd);
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

interface DispatchOptions {
  thread: string;
}

export function register(program: Command): void {
  program
    .command('dispatch')
    .description('（内部）检查所有订阅并为有未消费事件的 Consumer 启动 handler')
    .requiredOption('--thread <path>', 'Thread 目录路径')
    .addHelpText('after', `
Examples:
  $ thread dispatch --thread ./t`)
    .action(async (options: DispatchOptions) => {
      const threadDir = path.resolve(options.thread);
      assertValidThreadDir(threadDir);

      const logger = await createFileLogger(path.join(threadDir, 'logs'), 'thread');
      const db = openDb(threadDir);

      try {
        const subscriptions = getSubscriptions(db);

        for (const sub of subscriptions) {
          const progress = getConsumerProgress(db, sub.consumer_id);
          const lastAckedId = progress?.last_acked_id ?? 0;

          // Check if there are unconsumed events for this consumer
          if (!hasUnconsumedEvents(db, lastAckedId, sub.filter)) {
            continue;
          }

          // Try to acquire lock
          const runDir = path.join(threadDir, 'run');
          mkdirSync(runDir, { recursive: true });
          const lockPath = path.join(runDir, `${sub.consumer_id}.lock`);

          if (!tryLock(lockPath)) {
            logger.info(`dispatch: consumer=${sub.consumer_id} skipped (lock held)`);
            continue;
          }

          // Spawn handler in detached mode with shell: true
          const child = spawn(sub.handler_cmd, [], {
            shell: true,
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
          });
          child.unref();

          logger.info(`dispatch: consumer=${sub.consumer_id} spawned handler_cmd="${sub.handler_cmd}"`);
        }
      } finally {
        db.close();
        await logger.close();
      }
    });
}
