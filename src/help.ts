import type { Command } from 'commander';

const MAIN_EXAMPLES = `
Examples:
  $ thread init ./my-thread
  $ thread push --thread ./my-thread --source agent-007 --type message --content "hello"
  $ thread push --thread ./my-thread --source agent-007 --type record --batch < events.jsonl
  $ thread subscribe --thread ./my-thread --consumer worker-1 --handler "pai chat --thread ./my-thread --consumer worker-1"
  $ thread pop --thread ./my-thread --consumer worker-1 --last-event-id 0
  $ thread dispatch --thread ./my-thread
  $ thread info --thread ./my-thread --json`;

const MAIN_VERBOSE = `
Data:
  每个 thread 是一个自包含目录，通过 --thread <path> 指定。
  目录结构:
    <thread-dir>/
    ├── events.db          SQLite 数据库（WAL 模式）
    ├── events.jsonl       只追加的事件日志（供调试浏览）
    ├── run/               Consumer 运行时 .lock 文件
    └── logs/thread.log    运行日志

Exit Codes:
  0  成功
  1  一般逻辑错误（订阅已存在、目录不是有效 thread 等）
  2  参数/语法错误（缺少必需参数、类型非法等）`;

export function installHelp(program: Command): void {
  program.addHelpText('after', MAIN_EXAMPLES);
  installVerboseHelp(program);
}

function installVerboseHelp(program: Command): void {
  program.option('--verbose', '(与 --help 一起使用) 显示完整帮助信息');
  program.on('option:verbose', () => {
    (program as unknown as Record<string, boolean>).__verboseHelp = true;
  });
  program.addHelpText('afterAll', () => {
    if ((program as unknown as Record<string, boolean>).__verboseHelp) {
      return MAIN_VERBOSE;
    }
    return '';
  });
}
