import type { Command } from 'commander';
import * as fs from 'node:fs';
import { openDb, initSchema } from '../db/init.js';
import { path } from '../repo-utils/path.js';

function isValidThreadDir(dirPath: string): boolean {
  return fs.existsSync(path.join(dirPath, 'events.db'));
}

export function register(program: Command): void {
  program
    .command('init')
    .description('初始化一个新的 thread 目录')
    .argument('<path>', '目标目录路径')
    .addHelpText('after', `
Examples:
  $ thread init ./my-thread
  $ thread init /tmp/agent-thread`)
    .action((targetPath: string) => {
      const resolved = path.resolve(targetPath);

      // Check if already a valid thread directory
      if (isValidThreadDir(resolved)) {
        process.stderr.write(
          `Error: ${resolved} 已是有效的 thread 目录 - 如需重新初始化，请先删除该目录\n`
        );
        process.exit(1);
      }

      // Create directory structure
      fs.mkdirSync(path.join(resolved, 'run'), { recursive: true });
      fs.mkdirSync(path.join(resolved, 'logs'), { recursive: true });

      // Initialize SQLite database
      const db = openDb(resolved);
      initSchema(db);
      db.close();

      // Create empty events.jsonl
      const jsonlPath = path.join(resolved, 'events.jsonl');
      if (!fs.existsSync(jsonlPath)) {
        fs.writeFileSync(jsonlPath, '', 'utf8');
      }

      process.stdout.write(`Initialized thread at ${resolved}\n`);
    });
}
