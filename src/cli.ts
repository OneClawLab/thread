import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installHelp } from './help.js';
import { register as registerInit } from './commands/init.js';
import { register as registerPush } from './commands/push.js';
import { register as registerPop } from './commands/pop.js';
import { register as registerPeek } from './commands/peek.js';
import { register as registerDispatch } from './commands/dispatch.js';
import { register as registerSubscribe } from './commands/subscribe.js';
import { register as registerUnsubscribe } from './commands/unsubscribe.js';
import { register as registerInfo } from './commands/info.js';

// Gracefully handle EPIPE (e.g. broken pipe)
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});
process.stderr.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(
  readFileSync(join(__dirname, '../package.json'), 'utf8')
) as { version: string };

const program = new Command();

program
  .name('thread')
  .description('基于 SQLite 的事件队列 CLI 工具')
  .version(packageJson.version)
  .showHelpAfterError(true)
  .configureOutput({
    writeErr: (str) => process.stderr.write(str),
    writeOut: (str) => process.stdout.write(str),
  });

program.exitOverride();

installHelp(program);

// Register all subcommands
registerInit(program);
registerPush(program);
registerPop(program);
registerPeek(program);
registerDispatch(program);
registerSubscribe(program);
registerUnsubscribe(program);
registerInfo(program);

// Unknown commands → exit 2
program.on('command:*', () => {
  process.stderr.write(`Invalid command: ${program.args.join(' ')}\nSee --help for available commands.\n`);
  process.exit(2);
});

(async () => {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err && typeof err === 'object' && 'exitCode' in err) {
      const exitCode = (err as { exitCode: number }).exitCode;
      // Map commander's exit code 1 (argument errors) to 2 per spec
      process.exitCode = exitCode === 1 ? 2 : exitCode;
    } else {
      process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 2;
    }
  }
})();
