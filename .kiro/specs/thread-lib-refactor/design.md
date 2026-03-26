# 设计文档：thread CLI/LIB 双接口改造

## 概述

将 thread 从纯 CLI 模块改造为 CLI/LIB 双接口模块。核心变化是新增 `src/lib/` 目录，将业务逻辑从 CLI 层剥离，封装为可被外部 import 的 `ThreadLib` 和 `ThreadStore` 类。CLI 层重构为薄包装，调用 lib 层实现，保持所有命令行为与 v1 完全兼容。

改造后 xar 可以直接 `import { ThreadLib, ThreadStore } from '@theclawlab/thread'` 使用，无需通过 CLI 子进程调用。

## 架构

```
thread/src/
├── lib/                          ← 核心业务逻辑（无 CLI 依赖）
│   ├── types.ts                  ← ThreadEvent, ThreadEventInput, PeekOptions, ThreadError
│   ├── db.ts                     ← SQLite 操作（从 db/ 提取，新增 peek 查询）
│   ├── event-log.ts              ← JSONL 追加写入（从 src/ 迁移）
│   ├── thread-store.ts           ← ThreadStore 类（push/pushBatch/peek/close）
│   └── thread-lib.ts             ← ThreadLib 类（open/init/exists/destroy）
├── commands/                     ← CLI 子命令（薄包装，调用 lib/）
│   ├── init.ts                   ← 调用 ThreadLib.init()
│   ├── push.ts                   ← 调用 ThreadStore.push() + notifier dispatch
│   ├── peek.ts                   ← 调用 ThreadStore.peek()
│   ├── pop.ts                    ← 保持现有实现（不涉及 lib）
│   ├── dispatch.ts               ← 保持现有实现
│   ├── subscribe.ts              ← 保持现有实现
│   ├── unsubscribe.ts            ← 保持现有实现
│   └── info.ts                   ← 保持现有实现
├── notifier-client.ts            ← CLI 层：调用 notifier CLI（保留）
├── help.ts                       ← CLI 层：--help 输出（保留）
├── index.ts                      ← LIB 入口：export lib/ 公开接口
└── cli.ts                        ← CLI 入口：原 index.ts 改名
```

### 依赖关系

```
src/index.ts (LIB 入口)
  └── src/lib/thread-lib.ts
  └── src/lib/thread-store.ts
  └── src/lib/types.ts

src/cli.ts (CLI 入口)
  └── src/commands/*.ts
        └── src/lib/thread-lib.ts   (init, push, peek 命令)
        └── src/lib/thread-store.ts (push, peek 命令)
        └── src/notifier-client.ts  (push 命令)
        └── src/db/*.ts             (pop, dispatch, subscribe, info 命令，暂不迁移)
```

### 关键设计决策

**决策 1：CLI push 保留 notifier dispatch，LIB push 不触发**
CLI 的 `thread push` 命令在写入事件后调用 `scheduleDispatch()`，这是 v1 的核心行为，必须保留。LIB 的 `ThreadStore.push()` 不触发 notifier，因为 xar 自己管理调度。notifier 触发逻辑保留在 `src/commands/push.ts`，不进入 lib 层。

**决策 2：ThreadStore 持有长期 SQLite 连接**
xar run-loop 在 agent 启动时 open，agent 停止时 close，复用同一连接避免频繁开关。`ThreadStore` 构造时建立连接，`close()` 时释放。CLI 命令每次调用后立即 close（短生命周期）。

**决策 3：pop/dispatch/subscribe/unsubscribe/info 命令暂不迁移到 lib**
xar 不需要这些功能（subscribe/dispatch 是 v1 notifier 模型的产物）。这些命令继续直接使用 `src/db/` 层，不引入 lib 抽象，减少改造范围。

**决策 4：ThreadLib.open() 幂等，ThreadLib.init() 严格新建**
`open()` 适用于 xar run-loop 的"按需打开"场景，不关心是否已存在。`init()` 适用于 `xar init` 的"必须是新建"场景，已存在则 throw。

## 组件与接口

### `src/lib/types.ts`

```typescript
export interface ThreadEventInput {
  source: string
  type: 'message' | 'record'
  subtype?: string
  content: string
}

export interface ThreadEvent extends ThreadEventInput {
  id: number
  created_at: string
  subtype: string | null   // 覆盖父接口，存储时为 null（非 undefined）
}

export interface PeekOptions {
  lastEventId: number      // 返回 id > lastEventId 的事件；0 表示从头
  limit?: number           // 默认 100
  filter?: string          // SQL WHERE 子句片段
}

export type ThreadErrorCode =
  | 'THREAD_ALREADY_EXISTS'
  | 'THREAD_NOT_INITIALIZED'
  | 'THREAD_CLOSED'

export class ThreadError extends Error {
  constructor(
    message: string,
    public readonly code: ThreadErrorCode
  ) {
    super(message)
    this.name = 'ThreadError'
  }
}
```

### `src/lib/db.ts`

从现有 `src/db/init.ts` 和 `src/db/queries.ts` 提取，新增 `peekEvents()` 函数（与现有 `popEvents()` 相同逻辑，语义上区分"只读查询"）：

```typescript
// 从 db/init.ts 迁移
export function openDb(threadDir: string): Database.Database
export function initSchema(db: Database.Database): void

// 从 db/queries.ts 迁移（仅 lib 需要的部分）
export function insertEvent(db: Database.Database, payload: ThreadEventInput): number
export function insertEventsBatch(db: Database.Database, payloads: ThreadEventInput[]): number[]
export function peekEvents(
  db: Database.Database,
  lastEventId: number,
  filter: string | null,
  limit: number
): ThreadEvent[]

// 保留在 db/queries.ts 供 CLI 命令使用（pop/subscribe/info 等）
// 不迁移到 lib/db.ts
```

### `src/lib/event-log.ts`

从现有 `src/event-log.ts` 迁移，接口不变：

```typescript
export function appendEventLog(threadDir: string, event: ThreadEvent): void
export function appendEventsBatch(threadDir: string, events: ThreadEvent[]): void
export function rotateIfNeeded(threadDir: string): void
```

### `src/lib/thread-store.ts`

```typescript
import Database from 'better-sqlite3'
import { ThreadEvent, ThreadEventInput, PeekOptions, ThreadError } from './types.js'
import { insertEvent, insertEventsBatch, peekEvents } from './db.js'
import { appendEventLog, appendEventsBatch } from './event-log.js'

export class ThreadStore {
  readonly threadPath: string
  private db: Database.Database
  private closed = false

  constructor(threadPath: string, db: Database.Database) {
    this.threadPath = threadPath
    this.db = db
  }

  async push(event: ThreadEventInput): Promise<ThreadEvent>
  async pushBatch(events: ThreadEventInput[]): Promise<ThreadEvent[]>
  async peek(opts: PeekOptions): Promise<ThreadEvent[]>
  close(): void
}
```

`push()` 实现：
1. 检查 `closed`，若已关闭则 throw `ThreadError('THREAD_CLOSED')`
2. 调用 `insertEvent(db, event)` 获取 `id`
3. 构造 `ThreadEvent`（含 `id`、`created_at: new Date().toISOString()`）
4. 调用 `appendEventLog(threadPath, event)`
5. 返回 `ThreadEvent`

`pushBatch()` 实现：
1. 检查 `closed`
2. 若 `events` 为空，返回 `[]`
3. 调用 `insertEventsBatch(db, events)` 获取 `ids[]`
4. 构造 `ThreadEvent[]`
5. 调用 `appendEventsBatch(threadPath, events)`
6. 返回 `ThreadEvent[]`

`peek()` 实现：
1. 检查 `closed`
2. 调用 `peekEvents(db, lastEventId, filter ?? null, limit ?? 100)`
3. 返回结果

`close()` 实现：
1. 若已 `closed`，直接返回（幂等）
2. 调用 `db.close()`
3. 设置 `closed = true`

### `src/lib/thread-lib.ts`

```typescript
import { ThreadStore } from './thread-store.js'
import { ThreadError } from './types.js'
import { openDb, initSchema } from './db.js'

export class ThreadLib {
  async open(threadPath: string): Promise<ThreadStore>
  async init(threadPath: string): Promise<ThreadStore>
  async exists(threadPath: string): Promise<boolean>
  async destroy(threadPath: string): Promise<void>
}
```

`open()` 实现：
1. 检查 `events.db` 是否存在
2. 若不存在：调用 `_initDir(threadPath)`（创建目录结构、initSchema、创建 events.jsonl）
3. 调用 `openDb(threadPath)`，返回 `new ThreadStore(threadPath, db)`

`init()` 实现：
1. 检查 `events.db` 是否存在
2. 若已存在：throw `new ThreadError('...', 'THREAD_ALREADY_EXISTS')`
3. 调用 `_initDir(threadPath)`
4. 调用 `openDb(threadPath)`，返回 `new ThreadStore(threadPath, db)`

`exists()` 实现：
1. 检查 `path.join(threadPath, 'events.db')` 是否存在
2. 返回 `boolean`

`destroy()` 实现：
1. 检查目录是否存在
2. 若不存在：直接返回（幂等）
3. 调用 `fs.rm(threadPath, { recursive: true, force: true })`

`_initDir()` 私有方法：
1. `mkdirSync(path.join(threadPath, 'run'), { recursive: true })`
2. `mkdirSync(path.join(threadPath, 'logs'), { recursive: true })`
3. `const db = openDb(threadPath); initSchema(db); db.close()`
4. 若 `events.jsonl` 不存在：`writeFileSync(path.join(threadPath, 'events.jsonl'), '')`

### `src/index.ts`（LIB 入口）

```typescript
export { ThreadLib } from './lib/thread-lib.js'
export { ThreadStore } from './lib/thread-store.js'
export type { ThreadEvent, ThreadEventInput, PeekOptions } from './lib/types.js'
export { ThreadError } from './lib/types.js'
```

无任何顶层副作用代码。

### `src/cli.ts`（CLI 入口）

原 `src/index.ts` 内容原样迁移，仅修改文件名。所有 EPIPE 处理、`exitOverride()`、错误码映射保持不变。

### `src/commands/init.ts`（更新）

```typescript
// 替换现有的直接文件操作，改为调用 ThreadLib.init()
import { ThreadLib } from '../lib/thread-lib.js'
import { ThreadError } from '../lib/types.js'

const lib = new ThreadLib()
try {
  const store = await lib.init(resolved)
  store.close()
  process.stdout.write(`Initialized thread at ${resolved}\n`)
} catch (err) {
  if (err instanceof ThreadError && err.code === 'THREAD_ALREADY_EXISTS') {
    process.stderr.write(`Error: ${resolved} 已是有效的 thread 目录 - 如需重新初始化，请先删除该目录\n`)
    process.exit(1)
  }
  throw err
}
```

### `src/commands/push.ts`（更新）

```typescript
// 替换直接 db 操作，改为调用 ThreadStore.push() / pushBatch()
// 保留 scheduleDispatch() 调用（CLI 特有行为）
import { ThreadLib } from '../lib/thread-lib.js'

const lib = new ThreadLib()
const store = await lib.open(threadDir)
try {
  if (options.batch) {
    const events = await store.pushBatch(payloads)
    // ... scheduleDispatch
  } else {
    const event = await store.push(payload)
    // ... scheduleDispatch
  }
} finally {
  store.close()
}
```

### `src/commands/peek.ts`（更新）

```typescript
// 替换直接 db 操作，改为调用 ThreadStore.peek()
import { ThreadLib } from '../lib/thread-lib.js'

const lib = new ThreadLib()
const store = await lib.open(threadDir)
try {
  const events = await store.peek({ lastEventId, limit, filter })
  for (const event of events) {
    process.stdout.write(JSON.stringify(event) + '\n')
  }
} finally {
  store.close()
}
```

## 数据模型

### SQLite Schema（不变）

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

CREATE TABLE IF NOT EXISTS subscriptions (
  consumer_id  TEXT NOT NULL,
  handler_cmd  TEXT NOT NULL,
  filter       TEXT,
  PRIMARY KEY (consumer_id)
);

CREATE TABLE IF NOT EXISTS consumer_progress (
  consumer_id   TEXT    NOT NULL PRIMARY KEY,
  last_acked_id INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT    NOT NULL
);
```

### Thread 目录结构（不变）

```
<threadPath>/
├── events.db       ← SQLite 数据库（存在即代表已初始化）
├── events.jsonl    ← JSONL 追加日志（备份/审计用）
├── logs/           ← 日志目录
└── run/            ← 运行时目录
```

### `tsup.config.ts`（v2）

```typescript
import { defineConfig } from 'tsup'

export default defineConfig([
  {
    // LIB 入口：无 shebang，生成类型声明
    entry: ['src/index.ts'],
    format: ['esm'],
    target: 'node22',
    clean: true,
    sourcemap: true,
    dts: true,
  },
  {
    // CLI 入口：带 shebang，不生成类型声明
    entry: ['src/cli.ts'],
    format: ['esm'],
    target: 'node22',
    sourcemap: true,
    dts: false,
    banner: { js: '#!/usr/bin/env node' },
  },
])
```

### `package.json` 变更

```json
{
  "exports": { ".": "./dist/index.js" },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "bin": { "thread": "./dist/cli.js" },
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "test:coverage": "vitest run --coverage",
    "release:local": "npm run build && npm link"
  }
}
```

## 正确性属性

*属性（property）是在系统所有有效执行中都应成立的特征或行为——本质上是对系统应做什么的形式化陈述。属性是人类可读规范与机器可验证正确性保证之间的桥梁。*

---

**Property 1：open() 自动初始化**
*对于任意* 不存在的临时路径，调用 `ThreadLib.open()` 后，该路径应成为有效 thread（`events.db` 存在），且返回的 `ThreadStore` 可以成功执行 `push()` 和 `peek()`
**Validates: Requirements 1.1, 1.3**

---

**Property 2：open() 幂等性**
*对于任意* 已初始化的 thread 路径，多次调用 `ThreadLib.open()` 均应成功，且每次 open 后通过 `peek()` 读取的事件数量与第一次 open 后写入的事件数量一致（不破坏已有数据）
**Validates: Requirements 1.2, 1.4**

---

**Property 3：init() 严格新建**
*对于任意* 已初始化的 thread 路径，调用 `ThreadLib.init()` 应 throw `ThreadError`，且 `error.code === 'THREAD_ALREADY_EXISTS'`，且 thread 中已有的事件数量不变（不修改现有数据）
**Validates: Requirements 2.2, 2.3**

---

**Property 4：exists() 正确反映 thread 状态**
*对于任意* 路径，`ThreadLib.exists()` 的返回值应与该路径下 `events.db` 是否存在严格一致：init 后返回 true，destroy 后返回 false，从未初始化的路径返回 false
**Validates: Requirements 3.1, 3.2, 4.3**

---

**Property 5：destroy() round-trip**
*对于任意* 已初始化的 thread 路径，调用 `ThreadLib.destroy()` 后，`ThreadLib.exists()` 应返回 false，且对不存在路径调用 `destroy()` 不应抛出错误（幂等）
**Validates: Requirements 4.1, 4.2**

---

**Property 6：push() round-trip**
*对于任意* 有效的 `ThreadEventInput`（随机 source、type、content，可选 subtype），调用 `ThreadStore.push()` 后，通过 `ThreadStore.peek({ lastEventId: 0 })` 应能读回该事件，且读回的事件内容与输入完全一致，`id` 为正整数，`created_at` 为有效 ISO 8601 字符串，未提供 `subtype` 时存储为 `null`
**Validates: Requirements 5.1, 5.3, 5.4**

---

**Property 7：push() id 严格递增**
*对于任意* 事件序列，依次调用 `ThreadStore.push()` 返回的 `id` 应严格单调递增（每次 +1 或更大，且均为正整数）
**Validates: Requirements 5.3**

---

**Property 8：pushBatch() round-trip**
*对于任意* 非空 `ThreadEventInput[]`，调用 `ThreadStore.pushBatch()` 后，返回数组长度应与输入一致，顺序一致，且通过 `peek()` 可以读回所有事件；对空数组调用应返回 `[]` 且不修改数据库
**Validates: Requirements 6.1, 6.2**

---

**Property 9：peek() 过滤正确性**
*对于任意* 事件序列和任意 `lastEventId` 值 N，`ThreadStore.peek({ lastEventId: N })` 返回的所有事件的 `id` 均应严格大于 N，且结果按 `id` 升序排列
**Validates: Requirements 7.1, 7.2**

---

**Property 10：peek() limit 约束**
*对于任意* 包含超过 L 条事件的 thread，`ThreadStore.peek({ lastEventId: 0, limit: L })` 返回的事件数量应 ≤ L；未指定 limit 时默认最多返回 100 条
**Validates: Requirements 7.3**

---

**Property 11：peek() 幂等性**
*对于任意* thread 和任意 `PeekOptions`，多次调用 `ThreadStore.peek()` 且中间不写入新事件，应返回完全相同的结果（不修改数据库状态）
**Validates: Requirements 7.5**

---

**Property 12：close() 后操作抛出错误**
*对于任意* `ThreadStore` 实例，调用 `close()` 后，调用 `push()`、`pushBatch()` 或 `peek()` 均应 throw 错误（`ThreadError` 或 SQLite 错误）
**Validates: Requirements 8.2**

---

**Property 13：lib 错误不调用 process.exit()**
*对于任意* 会触发错误的操作（init 已存在路径、close 后操作等），lib 层应 throw `ThreadError`，不调用 `process.exit()`，不写 stdout/stderr
**Validates: Requirements 9.2**

## 错误处理

### ThreadError 错误码

| code | 触发场景 |
|------|---------|
| `THREAD_ALREADY_EXISTS` | `ThreadLib.init()` 时目标路径已是有效 thread |
| `THREAD_NOT_INITIALIZED` | 操作一个未初始化的 thread（预留，当前 open() 会自动初始化） |
| `THREAD_CLOSED` | `ThreadStore` 已 close 后调用任意方法 |

### CLI 层错误映射

| 错误 | CLI 行为 |
|------|---------|
| `ThreadError(THREAD_ALREADY_EXISTS)` | stderr 输出提示，exit 1 |
| `ThreadError(THREAD_CLOSED)` | stderr 输出提示，exit 1 |
| SQLite 错误 | stderr 输出原始错误，exit 1 |
| 参数错误（commander） | stderr 输出提示，exit 2 |

### LIB 层约定

- 所有 lib 函数在错误时 throw，不 exit
- 不写 stdout/stderr
- SQLite 错误直接向上传播（不包装为 ThreadError）

## 测试策略

### 工具选择

- 测试框架：**vitest**（`vitest run` 单次运行）
- 属性测试库：**fast-check**（最少 100 次迭代）
- 测试文件位置：`vitest/unit/`（单元测试）、`vitest/pbt/`（属性测试）

### 单元测试（`vitest/unit/`）

针对具体示例和边界情况：

- `thread-lib.test.ts`：`open()`/`init()`/`exists()`/`destroy()` 的具体行为示例
- `thread-store.test.ts`：`push()`/`pushBatch()`/`peek()`/`close()` 的具体行为示例
- `cli-compat.test.ts`：CLI 命令兼容性（通过 `execa` 或直接调用 command handler）

重点覆盖：
- `open()` 对不存在路径、已存在路径、空目录三种情况
- `init()` 对已存在 thread 抛出正确错误码
- `close()` 后操作抛出错误
- CLI `push` 触发 notifier dispatch（mock `scheduleDispatch`）
- CLI `push` 与 LIB `push` 的行为差异

### 属性测试（`vitest/pbt/`）

使用 fast-check 验证 Properties 1-13：

- `thread-lib.pbt.test.ts`：Properties 1-5（ThreadLib 操作）
- `thread-store.pbt.test.ts`：Properties 6-13（ThreadStore 操作）

**fast-check 生成器设计**：

```typescript
// 随机 ThreadEventInput 生成器
const arbEventInput = fc.record({
  source: fc.string({ minLength: 1, maxLength: 50 }),
  type: fc.constantFrom('message', 'record'),
  subtype: fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: undefined }),
  content: fc.string({ minLength: 0, maxLength: 500 }),
})

// 随机事件数组生成器（1-20 条）
const arbEventInputArray = fc.array(arbEventInput, { minLength: 1, maxLength: 20 })

// 临时目录生成器（每次测试使用独立目录，测试后清理）
const arbTempDir = fc.string({ minLength: 5, maxLength: 20 })
  .map(suffix => path.join(os.tmpdir(), `thread-pbt-${suffix}-${Date.now()}`))
```

**测试配置**：

```typescript
// vitest/pbt/thread-store.pbt.test.ts
import { fc } from 'fast-check'

// 每个属性测试最少 100 次迭代
// Feature: thread-lib-refactor, Property 6: push round-trip
it('push round-trip', async () => {
  await fc.assert(
    fc.asyncProperty(arbEventInput, async (input) => {
      const dir = makeTempDir()
      try {
        const lib = new ThreadLib()
        const store = await lib.open(dir)
        const event = await store.push(input)
        const events = await store.peek({ lastEventId: 0 })
        store.close()
        // 验证 round-trip
        expect(events).toHaveLength(1)
        expect(events[0]!.source).toBe(input.source)
        expect(events[0]!.content).toBe(input.content)
        expect(events[0]!.id).toBeGreaterThan(0)
      } finally {
        await fs.rm(dir, { recursive: true, force: true })
      }
    }),
    { numRuns: 100 }
  )
})
```

### 测试隔离

- 每个属性测试使用独立临时目录（`os.tmpdir()` + 随机后缀）
- 测试后清理临时目录（`finally` 块）
- `vitest.config.ts` 中 `fileParallelism: false` 避免并发 SQLite 争用
