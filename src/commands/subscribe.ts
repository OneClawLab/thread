import type { Command } from 'commander';
import * as fs from 'node:fs';
import { path } from '../repo-utils/path.js';
import { openDb } from '../db/init.js';
import { getSubscription, insertSubscription } from '../db/queries.js';

function assertValidThreadDir(threadDir: string): void {
  if (!fs.existsSync(path.join(threadDir, 'events.db'))) {
    process.stderr.write(
      `Error: ${threadDir} 不是有效的 thread 目录 - 请先运行 thread init ${threadDir}\n`
    );
    process.exit(1);
  }
}

interface SubscribeOptions {
  thread: string;
  consumer: string;
  handler: string;
  filter?: string;
}

export function register(program: Command): void {
  program
    .command('subscribe')
    .description('注册 Consumer 订阅')
    .requiredOption('--thread <path>', 'Thread 目录路径')
    .requiredOption('--consumer <id>', 'Consumer ID')
    .requiredOption('--handler <cmd>', 'Handler 命令')
    .option('--filter <sql-where>', 'SQL WHERE 子句片段（为空时订阅全部事件）')
    .addHelpText('after', `
Examples:
  $ thread subscribe --thread ./t --consumer worker-1 --handler "pai chat --thread ./t --consumer worker-1"
  $ thread subscribe --thread ./t --consumer worker-2 --handler "my-handler" --filter "type = 'message'"`)
    .action((options: SubscribeOptions) => {
      const threadDir = path.resolve(options.thread);
      assertValidThreadDir(threadDir);

      const db = openDb(threadDir);
      try {
        const existing = getSubscription(db, options.consumer);
        if (existing) {
          process.stderr.write(
            `Error: consumer '${options.consumer}' 已存在订阅 - 请先运行 thread unsubscribe --thread ${threadDir} --consumer ${options.consumer}\n`
          );
          process.exit(1);
        }

        insertSubscription(db, {
          consumer_id: options.consumer,
          handler_cmd: options.handler,
          filter: options.filter ?? null,
        });

        process.stdout.write(`Subscribed consumer '${options.consumer}'\n`);
      } finally {
        db.close();
      }
    });
}
