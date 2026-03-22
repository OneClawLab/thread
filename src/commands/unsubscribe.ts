import type { Command } from 'commander';
import * as fs from 'node:fs';
import { openDb } from '../db/init.js';
import { getSubscription, deleteSubscription } from '../db/queries.js';
import { path } from '../repo-utils/path.js';

function assertValidThreadDir(threadDir: string): void {
  if (!fs.existsSync(path.join(threadDir, 'events.db'))) {
    process.stderr.write(
      `Error: ${threadDir} 不是有效的 thread 目录 - 请先运行 thread init ${threadDir}\n`
    );
    process.exit(1);
  }
}

interface UnsubscribeOptions {
  thread: string;
  consumer: string;
}

export function register(program: Command): void {
  program
    .command('unsubscribe')
    .description('注销 Consumer 订阅')
    .requiredOption('--thread <path>', 'Thread 目录路径')
    .requiredOption('--consumer <id>', 'Consumer ID')
    .addHelpText('after', `
Examples:
  $ thread unsubscribe --thread ./t --consumer worker-1`)
    .action((options: UnsubscribeOptions) => {
      const threadDir = path.resolve(options.thread);
      assertValidThreadDir(threadDir);

      const db = openDb(threadDir);
      try {
        const existing = getSubscription(db, options.consumer);
        if (!existing) {
          process.stderr.write(
            `Error: consumer '${options.consumer}' 不存在订阅 - 请检查 consumer ID 是否正确\n`
          );
          process.exit(1);
        }

        deleteSubscription(db, options.consumer);
        process.stdout.write(`Unsubscribed consumer '${options.consumer}'\n`);
      } finally {
        db.close();
      }
    });
}
