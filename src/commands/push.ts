import type { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { openDb } from '../db/init.js';
import { insertEvent, insertEventsBatch } from '../db/queries.js';
import { appendEventLog, appendEventsBatch, rotateIfNeeded } from '../event-log.js';
import { scheduleDispatch } from '../notifier-client.js';
import { createFileLogger } from '../logger.js';
import type { PushPayload, Event } from '../types.js';

function assertValidThreadDir(threadDir: string): void {
  if (!fs.existsSync(path.join(threadDir, 'events.db'))) {
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

      const logger = await createFileLogger(threadDir);
      const db = openDb(threadDir);

      try {
        if (options.batch) {
          // Batch mode: read NDJSON from stdin
          const payloads: PushPayload[] = [];
          const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
          for await (const line of rl) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const obj = JSON.parse(trimmed) as Record<string, unknown>;
            payloads.push({
              source: String(obj['source'] ?? ''),
              type: String(obj['type'] ?? ''),
              subtype: obj['subtype'] != null ? String(obj['subtype']) : null,
              content: String(obj['content'] ?? ''),
            });
          }

          if (payloads.length === 0) {
            db.close();
            await logger.close();
            return;
          }

          const ids = insertEventsBatch(db, payloads);

          // Build full event objects for JSONL
          const events: Event[] = payloads.map((p, i) => ({
            id: ids[i] as number,
            created_at: new Date().toISOString(),
            source: p.source,
            type: p.type,
            subtype: p.subtype ?? null,
            content: p.content,
          }));

          rotateIfNeeded(threadDir);
          appendEventsBatch(threadDir, events);

          const lastPayload = payloads[payloads.length - 1];
          if (lastPayload) {
            await scheduleDispatch(threadDir, lastPayload.source, logger);
          }
          logger.info(`push batch: count=${payloads.length} last_id=${ids[ids.length - 1]}`);
        } else {
          // Single mode
          if (!options.source) {
            process.stderr.write('Error: --source 是必需参数 - 请提供事件来源标识\n');
            db.close();
            await logger.close();
            process.exit(2);
          }
          if (!options.type) {
            process.stderr.write('Error: --type 是必需参数 - 请提供事件类型\n');
            db.close();
            await logger.close();
            process.exit(2);
          }
          if (options.content === undefined) {
            process.stderr.write('Error: --content 是必需参数（单条模式）- 或使用 --batch 从 stdin 读取\n');
            db.close();
            await logger.close();
            process.exit(2);
          }

          const payload: PushPayload = {
            source: options.source,
            type: options.type,
            subtype: options.subtype ?? null,
            content: options.content,
          };

          const id = insertEvent(db, payload);
          const event: Event = {
            id,
            created_at: new Date().toISOString(),
            source: payload.source,
            type: payload.type,
            subtype: payload.subtype ?? null,
            content: payload.content,
          };

          appendEventLog(threadDir, event);
          await scheduleDispatch(threadDir, payload.source, logger);
          logger.info(`push: source=${payload.source} type=${payload.type} id=${id}`);
        }
      } finally {
        db.close();
        await logger.close();
      }
    });
}
