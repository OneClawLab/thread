import type { Command } from 'commander';
import { existsSync } from '../repo-utils/fs.js';
import { path } from '../repo-utils/path.js';
import { openDb } from '../db/init.js';
import { getThreadInfo } from '../db/queries.js';

function assertValidThreadDir(threadDir: string): void {
  if (!existsSync(path.join(threadDir, 'events.db'))) {
    process.stderr.write(
      `Error: ${threadDir} 不是有效的 thread 目录 - 请先运行 thread init ${threadDir}\n`
    );
    process.exit(1);
  }
}

interface InfoOptions {
  thread: string;
  json?: boolean;
}

export function register(program: Command): void {
  program
    .command('info')
    .description('查看 thread 状态摘要')
    .requiredOption('--thread <path>', 'Thread 目录路径')
    .option('--json', '以 JSON 格式输出')
    .addHelpText('after', `
Examples:
  $ thread info --thread ./t
  $ thread info --thread ./t --json`)
    .action((options: InfoOptions) => {
      const threadDir = path.resolve(options.thread);
      assertValidThreadDir(threadDir);

      const db = openDb(threadDir);
      try {
        const info = getThreadInfo(db);

        if (options.json) {
          process.stdout.write(JSON.stringify(info, null, 2) + '\n');
        } else {
          process.stdout.write(`Thread: ${threadDir}\n`);
          process.stdout.write(`Events: ${info.event_count}\n`);
          process.stdout.write(`Subscriptions: ${info.subscriptions.length}\n`);
          for (const sub of info.subscriptions) {
            process.stdout.write(`  - ${sub.consumer_id}\n`);
            process.stdout.write(`    handler: ${sub.handler_cmd}\n`);
            process.stdout.write(`    filter:  ${sub.filter ?? '(none)'}\n`);
            process.stdout.write(`    last_acked_id: ${sub.last_acked_id}\n`);
            process.stdout.write(`    updated_at: ${sub.updated_at ?? '(never)'}\n`);
          }
        }
      } finally {
        db.close();
      }
    });
}
