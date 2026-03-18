# 设计文档：thread-core

## 概述

`thread` 是一个基于 SQLite 的事件队列 CLI 工具，采用 TypeScript + ESM 构建，遵循 `pai` repo 约定。核心设计理念是"目录即 thread"——每个 thread 是一个自包含目录，无需中央注册服务。工具通过 `better-sqlite3` 直接操作 SQLite，利用 `notifier` CLI 实现幂等的异步 dispatch 调度。

## 架构

```
┌─────────────────────────────────────────────────────────┐
│                    thread CLI (index.ts)                  │
│                  commander 解析子命令                      │
└──────┬──────────┬──────────┬──────────┬──────────────────┘
       │          │          │          │
  ┌────▼───┐ ┌───▼────┐ ┌───▼────┐ ┌───▼────────────────┐
  │ init   │ │ push   │ │  pop   │ │ subscribe/         │
  │        │ │        │ │        │ │ unsubscribe/info    │
  └────┬───┘ └───┬────┘ └───┬────┘ └───┬────────────────┘
       │         │          │          │
       └────┬────┴──────────┴──────────┘
            │
  ┌─────────▼──────────────────────────────────────────┐
  │                  db/ 层                             │
  │  init.ts (schema/WAL)  queries.ts (SQL 封装)        │
  └─────────┬──────────────────────────────────────────┘
            │
  ┌─────────▼──────────────────────────────────────────┐
  │              支撑模块                               │
  │  event-log.ts    notifier-client.ts    logger.ts   │
  │  (JSONL 写入)    (notifier 调用)       (日志轮换)   │
  └────────────────────────────────────────────────────┘
```

### 关键设计决策

1. **目录即 ID**：`path.resolve()` 后的绝对路径作为 thread 唯一标识，无需注册表。
2. **双轨存储**：SQLite 用于查询和状态管理；JSONL 用于人类可读的调试浏览。
3. **幂等调度**：通过 notifier 的 task-id 机制确保 dispatch 不重复排队。
4. **at-least-once 语义**：`pop` 的 `--last-event-id` 是已处理完毕的最大 id，crash 后重传可重新获取未确认事件。
5. **文件锁防重入**：`run/<consumer_id>.lock` 确保同一 consumer 的 handler 不被重复启动。

## 组件与接口

### src/types.ts

```typescript
export interface Event {
  id: number;
  created_at: string;
  source: string;
  type: string;
  subtype: string | null;
  content: string;
}

export interface Subscription {
  consumer_id: string;
  handler_cmd: string;
  filter: string | null;
}

export interface ConsumerProgress {
  consumer_id: string;
  last_acked_id: number;
  updated_at: string;
}

export interface PushPayload {
  source: string;
  type: string;
  subtype?: string | null;
  content: string;
}

export interface ThreadInfo {
  event_count: number;
  subscriptions: Array<Subscription & { last_acked_id: number; updated_at: string | null }>;
}
```

### src/db/init.ts

```typescript
// 打开或创建 SQLite 数据库，执行 schema 迁移，开启 WAL 模式
export function openDb(threadDir: string): Database;
export function initSchema(db: Database): void;
```

### src/db/queries.ts

```typescript
export function insertEvent(db: Database, payload: PushPayload): number; // 返回 id
export function insertEventsBatch(db: Database, payloads: PushPayload[]): number[]; // 返回 id 列表
export function getSubscriptions(db: Database): Subscription[];
export function getSubscription(db: Database, consumerId: string): Subscription | null;
export function insertSubscription(db: Database, sub: Subscription): void;
export function deleteSubscription(db: Database, consumerId: string): void;
export function getConsumerProgress(db: Database, consumerId: string): ConsumerProgress | null;
export function upsertConsumerProgress(db: Database, consumerId: string, lastAckedId: number): void;
export function popEvents(db: Database, consumerId: string, lastEventId: number, limit: number): Event[];
export function hasUnconsumedEvents(db: Database, consumerId: string, lastAckedId: number, filter: string | null): boolean;
export function getEventCount(db: Database): number;
export function getThreadInfo(db: Database): ThreadInfo;
```

### src/event-log.ts

```typescript
// 追加事件到 JSONL 文件，push 前检查行数并在必要时轮换
export function appendEventLog(threadDir: string, event: Event): void;
export function appendEventsBatch(threadDir: string, events: Event[]): void;
export function rotateIfNeeded(threadDir: string): void; // 超过 10000 行时轮换
```

### src/notifier-client.ts

```typescript
// 调用 notifier CLI 触发 dispatch 调度
// 使用 execCommand() from os-utils.ts（从 pai repo 拷贝）
export function scheduleDispatch(threadDir: string, source: string): Promise<void>;
export function buildTaskId(threadDir: string): string; // 生成 thread_path_slug
```

### src/logger.ts

参考 notifier repo 的 `src/logger.ts` 实现，适配 thread 工具：

```typescript
export type LogLevel = 'INFO' | 'WARN' | 'ERROR';
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  close(): Promise<void>;
}
// 创建写入 <threadDir>/logs/thread.log 的 Logger，初始化时检查是否需要轮换
export async function createFileLogger(threadDir: string): Promise<Logger>;
// 创建写入 stderr 的 Logger（用于无 threadDir 时的错误输出）
export function createStderrLogger(): Logger;
```

轮换策略与 notifier 一致：超过 10000 行时重命名为 `thread-<YYYYMMDD-HHmmss>.log`。

### src/os-utils.ts

直接从 pai repo 拷贝 `src/os-utils.ts`，不做任何修改，不需要单独测试。提供 `execCommand`、`spawnCommand`、`commandExists` 等工具函数。

### src/help.ts

参考 pai/notifier repo 的 help.ts 模式：
- 定义 `MAIN_EXAMPLES` 和 `MAIN_VERBOSE` 常量
- 导出 `installHelp(program: Command): void`
- 支持 `--verbose` 与 `--help` 联用，显示退出码说明和数据目录信息
- 各子命令通过 `addHelpText('after', ...)` 添加示例

### src/commands/

每个子命令文件导出一个 `register(program: Command): void` 函数，向 commander 注册子命令。

### src/index.ts

参考 pai repo 的 `src/index.ts` 模式：
- 创建 commander program，设置版本（从 package.json 读取）
- 调用 `installHelp(program)`
- 注册所有子命令
- `program.exitOverride()` + try/catch，commander 退出码 1 映射为 2
- EPIPE 错误处理（`process.stdout.on('error', ...)`）
- 未知命令以退出码 2 退出

## 数据模型

### events 表

```sql
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  source     TEXT    NOT NULL,
  type       TEXT    NOT NULL,
  subtype    TEXT,
  content    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_source ON events(source);
CREATE INDEX IF NOT EXISTS idx_events_type   ON events(type);
```

### subscriptions 表

```sql
CREATE TABLE IF NOT EXISTS subscriptions (
  consumer_id  TEXT NOT NULL,
  handler_cmd  TEXT NOT NULL,
  filter       TEXT,
  PRIMARY KEY (consumer_id)
);
```

### consumer_progress 表

```sql
CREATE TABLE IF NOT EXISTS consumer_progress (
  consumer_id   TEXT    NOT NULL PRIMARY KEY,
  last_acked_id INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT    NOT NULL
);
```

### thread_path_slug 生成算法

```
slug = threadDir.replace(/[^a-zA-Z0-9]/g, '-')
if (slug.length > 40):
  slug = slug.slice(0, 32) + '-' + sha1(threadDir).slice(0, 6)
task_id = 'dispatch-' + slug
```

## 正确性属性

*属性（Property）是在系统所有合法执行中都应成立的特征或行为——本质上是对系统应做什么的形式化陈述。属性是人类可读规范与机器可验证正确性保证之间的桥梁。*

### 属性 1：push 后事件可查询（Round Trip）

*对于任意* 合法的 PushPayload，执行 push 后，通过 `id > 0` 查询应能取回该事件，且 `source`、`type`、`subtype`、`content` 字段与原始 payload 完全一致。

**验证：需求 2.1、2.2、2.3、2.4**

### 属性 2：batch push 原子性（Invariant）

*对于任意* 包含 N 条 payload 的 batch，执行 batch push 后，`events` 表中的事件总数应恰好增加 N；若 batch 中任意一条插入失败，则事件总数不变（全部回滚）。

**验证：需求 2.7、9.2**

### 属性 3：pop 过滤正确性（Metamorphic）

*对于任意* consumer（含非空 filter）和任意 `last-event-id`，`pop` 返回的所有事件都应满足：`id > last-event-id` 且符合 filter 条件；不应返回任何不满足条件的事件。

**验证：需求 3.4、3.7**

### 属性 4：pop 进度更新幂等性（Idempotence）

*对于任意* consumer，以相同的 `last-event-id` 连续执行两次 `pop`，`consumer_progress` 中的 `last_acked_id` 应等于该 `last-event-id`，且两次 pop 返回相同的事件集合。

**验证：需求 3.3**

### 属性 5：subscribe 后可查询（Round Trip）

*对于任意* 合法的 Subscription（consumer_id、handler_cmd、filter），执行 subscribe 后，通过 `getSubscription(consumer_id)` 应能取回完全相同的订阅记录。

**验证：需求 5.1、5.2、5.3**

### 属性 6：unsubscribe 后不可查询（Round Trip）

*对于任意* 已存在的 consumer_id，执行 unsubscribe 后，`getSubscription(consumer_id)` 应返回 null，且 `subscriptions` 表中不再包含该记录。

**验证：需求 5.5**

### 属性 7：thread_path_slug 长度约束（Invariant）

*对于任意* thread 目录路径，生成的 `thread_path_slug` 长度应不超过 40 个字符，且仅包含字母、数字和连字符。

**验证：需求 10.1、10.2、10.3**

### 属性 8：dispatch 文件锁防重入（Invariant）

*对于任意* consumer，当其 lock 文件已被持有时，dispatch 不应再次 spawn 该 consumer 的 handler；当 lock 文件未被持有时，dispatch 应能成功加锁并 spawn handler。

**验证：需求 4.4、4.5、4.6**

### 属性 9：日志轮换后行数约束（Invariant）

*对于任意* 日志文件，在写入导致行数超过 10000 后，旧文件应被重命名，新文件行数应从 1 开始；轮换前后日志内容不丢失。

**验证：需求 8.5**

### 属性 10：JSONL 轮换后内容完整性（Invariant）

*对于任意* `events.jsonl`，在行数超过 10000 触发轮换后，旧文件应被重命名保留，新文件为空；SQLite 中的事件数据不受影响。

**验证：需求 2.10**

## 错误处理

### 有效 thread 目录检测

所有命令（除 `init`）在执行前检查 `--thread <path>` 指定的目录是否包含 `events.db`。若不存在，输出 `Error: <path> 不是有效的 thread 目录 - 请先运行 thread init <path>` 并以退出码 1 退出。

### 数据库错误

SQLite 操作失败时，捕获异常，输出错误信息到 stderr，以退出码 1 退出。事务确保部分失败时数据不损坏。

### notifier 调用失败

notifier 返回退出码 0 或 1 均视为成功。返回其他退出码时，记录警告日志但不影响 push 的退出码（事件已成功写入）。

### 参数验证

commander 负责必需参数的存在性检查，缺少必需参数时以退出码 2 退出。业务逻辑层负责语义验证（如 consumer 是否存在）。

### 文件系统错误

目录创建、文件读写失败时，输出错误信息到 stderr 并以退出码 1 退出。

## 测试策略

### 双轨测试方法

- **单元测试**：验证具体示例、边界条件和错误处理路径。
- **属性测试（PBT）**：使用 `fast-check` 验证普遍性属性，覆盖大量随机输入。

两者互补，共同提供全面的正确性保证。

### 属性测试配置

- 框架：`vitest` + `fast-check`
- vitest 配置参考 notifier/pai repo：`fileParallelism: false`、`testTimeout: 10000`
- 每个属性测试最少运行 100 次迭代
- 每个属性测试通过注释标注对应的设计属性编号
- 标注格式：`// Feature: thread-core, Property N: <属性描述>`

### 单元测试重点

- `db/init.ts`：schema 创建、WAL 模式、重复初始化检测
- `db/queries.ts`：各 SQL 操作的正确性、边界值（id=0、空结果集）
- `event-log.ts`：JSONL 追加、轮换触发条件
- `notifier-client.ts`：slug 生成算法（`buildTaskId`）
- `logger.ts`：日志格式、轮换逻辑（参考 notifier 的 `createFileLogger` 模式）
- 各子命令：正常流程、错误流程、退出码

### os-utils.ts 说明

`src/os-utils.ts` 直接从 pai repo 拷贝，已在 pai repo 中经过测试，thread repo 中不需要重复测试。`notifier-client.ts` 使用其中的 `execCommand` 调用 notifier CLI。`dispatch.ts` 使用 `spawn`（直接 Node.js API）以分离模式启动 handler。

### 属性测试重点

- 属性 1：push-pop round trip（随机 payload）
- 属性 2：batch push 原子性（随机 batch 大小和内容）
- 属性 3：pop filter 正确性（随机 filter 和事件集）
- 属性 4：pop 幂等性（随机 consumer 和 last-event-id）
- 属性 5/6：subscribe/unsubscribe round trip（随机订阅数据）
- 属性 7：slug 长度约束（随机路径字符串）

### 测试目录结构

```
vitest/
├── unit/
│   ├── db-init.test.ts
│   ├── db-queries.test.ts
│   ├── event-log.test.ts
│   ├── notifier-client.test.ts
│   ├── logger.test.ts
│   └── commands/
│       ├── init.test.ts
│       ├── push.test.ts
│       ├── pop.test.ts
│       ├── dispatch.test.ts
│       ├── subscribe.test.ts
│       └── info.test.ts
├── pbt/
│   ├── push-pop.pbt.ts
│   ├── batch-push.pbt.ts
│   ├── pop-filter.pbt.ts
│   ├── subscribe.pbt.ts
│   └── slug.pbt.ts
└── helpers/
    └── thread-helpers.ts   # 测试用临时 thread 目录创建/清理（含临时 DB）
```
