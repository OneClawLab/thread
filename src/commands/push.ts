import type { Command } from 'commander';
import * as readline from 'node:readline';
import { existsSync } from '../repo-utils/fs.js';
import { scheduleDispatch } from '../notifier-client.js';
import { createFileLogger } from '../repo-utils/logger.js';
import { path } from '../repo-utils/path.js';
import { ThreadLib } from '../lib/thread-lib.js';
import type { ThreadEventInput } from '../lib/types.js';

function assertValidThreadDir(threadDir: string): void {
  if (!existsSync(path.join(threadDir, 'events.db'))) {
    process.stderr.write(
      `Error: ${threadDir} 不是有效的 thread 目录 - 请先运行 thread init ${threadDir}\n`
    );
    process.exit(1);
  }
}

interface PushOptions {
  thread: string;
  source?: string;
  type?: string;
  subtype?: string;
  content?: string;
  batch?: boolean;
}

export function register(program: Command): void {
  program
    .command('push')
    .description('推送事件到 thread')
    .requiredOption('--thread <path>', 'Thread 目录路径')
    .option('--source <name>', '事件来源标识')
    .option('--type <type>', '事件类型')
    .option('--subtype <subtype>', '事件子类型（可选）')
    .option('--content <data>', '事件内容（单条模式）')
    .option('--batch', '从 stdin 读取 NDJSON（每行一个事件对象）')
    .addHelpText('after', `
Examples:
  $ thread push --thread ./t --source agent-1 --type message --content "hello"
  $ thread push --thread ./t --source agent-1 --type record --subtype toolcall --content '{}'
  $ echo '{"source":"a","type":"message","content":"hi"}' | thread push --thread ./t --batch`)
    .action(async (options: PushOptions) => {
      const threadDir = path.resolve(options.thread);
      assertValidThreadDir(threadDir);

      const logger = await createFileLogger(path.join(threadDir, 'logs'), 'thread');
      const lib = new ThreadLib();
      const store = await lib.open(threadDir);

      try {
        if (options.batch) {
          // Batch mode: read NDJSON from stdin
          const payloads: ThreadEventInput[] = [];
          const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
          for await (const line of rl) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const obj = JSON.parse(trimmed) as Record<string, unknown>;
            const input: ThreadEventInput = {
              source: String(obj['source'] ?? ''),
              type: String(obj['type'] ?? '') as 'message' | 'record',
              content: String(obj['content'] ?? ''),
            };
            if (obj['subtype'] != null) {
              input.subtype = String(obj['subtype']);
            }
            payloads.push(input);
          }

          if (payloads.length === 0) {
            return;
          }

          const events = await store.pushBatch(payloads);

          const lastPayload = payloads[payloads.length - 1];
          if (lastPayload) {
            await scheduleDispatch(threadDir, lastPayload.source, logger);
          }
          const lastEvent = events[events.length - 1];
          logger.info(`push batch: count=${payloads.length} last_id=${lastEvent?.id}`);
        } else {
          // Single mode
          if (!options.source) {
            process.stderr.write('Error: --source 是必需参数 - 请提供事件来源标识\n');
            await logger.close();
            process.exit(2);
          }
          if (!options.type) {
            process.stderr.write('Error: --type 是必需参数 - 请提供事件类型\n');
            await logger.close();
            process.exit(2);
          }
          if (options.content === undefined) {
            process.stderr.write('Error: --content 是必需参数（单条模式）- 或使用 --batch 从 stdin 读取\n');
            await logger.close();
            process.exit(2);
          }

          const payload: ThreadEventInput = {
            source: options.source,
            type: options.type as 'message' | 'record',
            content: options.content,
          };
          if (options.subtype !== undefined) {
            payload.subtype = options.subtype;
          }

          const event = await store.push(payload);
          await scheduleDispatch(threadDir, payload.source, logger);
          logger.info(`push: source=${payload.source} type=${payload.type} id=${event.id}`);
        }
      } finally {
        store.close();
        await logger.close();
      }
    });
}
