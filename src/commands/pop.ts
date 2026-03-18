import type { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { openDb } from '../db/init.js';
import { getSubscription, upsertConsumerProgress, popEvents } from '../db/queries.js';

function assertValidThreadDir(threadDir: string): void {
  if (!fs.existsSync(path.join(threadDir, 'events.db'))) {
    process.stderr.write(
      `Error: ${threadDir} 不是有效的 thread 目录 - 请先运行 thread init ${threadDir}\n`
    );
    process.exit(1);
  }
}

interface PopOptions {
  thread: string;
  consumer: string;
  lastEventId: string;
  limit?: string;
}

export function register(program: Command): void {
  program
    .command('pop')
    .description('获取未处理的事件（NDJSON 输出到 stdout）')
    .requiredOption('--thread <path>', 'Thread 目录路径')
    .requiredOption('--consumer <id>', 'Consumer ID')
    .requiredOption('--last-event-id <id>', '上次已处理完毕的最大 event id（首次传 0）')
    .option('--limit <n>', '最多返回条数', '100')
    .addHelpText('after', `
Examples:
  $ thread pop --thread ./t --consumer worker-1 --last-event-id 0
  $ thread pop --thread ./t --consumer worker-1 --last-event-id 42 --limit 50`)
    .action((options: PopOptions) => {
      const threadDir = path.resolve(options.thread);
      assertValidThreadDir(threadDir);

      const lastEventId = parseInt(options.lastEventId, 10);
      if (isNaN(lastEventId) || lastEventId < 0) {
        process.stderr.write('Error: --last-event-id 必须是非负整数 - 首次消费请传 0\n');
        process.exit(2);
      }

      const limit = parseInt(options.limit ?? '100', 10);
      if (isNaN(limit) || limit <= 0) {
        process.stderr.write('Error: --limit 必须是正整数\n');
        process.exit(2);
      }

      const db = openDb(threadDir);
      try {
        const sub = getSubscription(db, options.consumer);
        if (!sub) {
          process.stderr.write(
            `Error: consumer '${options.consumer}' 不存在订阅 - 请先运行 thread subscribe\n`
          );
          process.exit(1);
        }

        // Update consumer progress (ACK the last processed id)
        upsertConsumerProgress(db, options.consumer, lastEventId);

        // Fetch events
        const events = popEvents(db, lastEventId, sub.filter, limit);
        for (const event of events) {
          process.stdout.write(JSON.stringify(event) + '\n');
        }
      } finally {
        db.close();
      }
    });
}
