import type { Command } from 'commander';
import * as fs from 'node:fs';
import { openDb } from '../db/init.js';
import { popEvents } from '../db/queries.js';
import { path } from '../repo-utils/path.js';

function assertValidThreadDir(threadDir: string): void {
  if (!fs.existsSync(path.join(threadDir, 'events.db'))) {
    process.stderr.write(
      `Error: ${threadDir} 不是有效的 thread 目录 - 请先运行 thread init ${threadDir}\n`
    );
    process.exit(1);
  }
}

interface PeekOptions {
  thread: string;
  lastEventId: string;
  limit?: string;
  filter?: string;
}

export function register(program: Command): void {
  program
    .command('peek')
    .description('只读查询事件（不更新消费进度，NDJSON 输出到 stdout）')
    .requiredOption('--thread <path>', 'Thread 目录路径')
    .requiredOption('--last-event-id <id>', '返回 id > 此值的事件；传 0 从头读取')
    .option('--limit <n>', '最多返回条数', '100')
    .option('--filter <sql-where>', 'SQL WHERE 子句片段')
    .addHelpText('after', `
Examples:
  $ thread peek --thread ./t --last-event-id 0
  $ thread peek --thread ./t --last-event-id 42 --limit 10
  $ thread peek --thread ./t --last-event-id 0 --filter "type = 'message'"`)
    .action((options: PeekOptions) => {
      const threadDir = path.resolve(options.thread);
      assertValidThreadDir(threadDir);

      const lastEventId = parseInt(options.lastEventId, 10);
      if (isNaN(lastEventId) || lastEventId < 0) {
        process.stderr.write('Error: --last-event-id 必须是非负整数 - 传 0 从头读取\n');
        process.exit(2);
      }

      const limit = parseInt(options.limit ?? '100', 10);
      if (isNaN(limit) || limit <= 0) {
        process.stderr.write('Error: --limit 必须是正整数\n');
        process.exit(2);
      }

      const db = openDb(threadDir);
      try {
        const events = popEvents(db, lastEventId, options.filter ?? null, limit);
        for (const event of events) {
          process.stdout.write(JSON.stringify(event) + '\n');
        }
      } finally {
        db.close();
      }
    });
}
