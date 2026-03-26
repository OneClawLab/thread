import type { Command } from 'commander';
import { path } from '../repo-utils/path.js';
import { ThreadLib } from '../lib/thread-lib.js';
import { ThreadError } from '../lib/types.js';

export function register(program: Command): void {
  program
    .command('init')
    .description('初始化一个新的 thread 目录')
    .argument('<path>', '目标目录路径')
    .addHelpText('after', `
Examples:
  $ thread init ./my-thread
  $ thread init /tmp/agent-thread`)
    .action(async (targetPath: string) => {
      const resolved = path.resolve(targetPath);

      const lib = new ThreadLib();
      try {
        const store = await lib.init(resolved);
        store.close();
        process.stdout.write(`Initialized thread at ${resolved}\n`);
      } catch (err) {
        if (err instanceof ThreadError && err.code === 'THREAD_ALREADY_EXISTS') {
          process.stderr.write(
            `Error: ${resolved} 已是有效的 thread 目录 - 如需重新初始化，请先删除该目录\n`
          );
          process.exit(1);
        }
        throw err;
      }
    });
}
