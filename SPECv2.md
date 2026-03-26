# thread SPECv2 - CLI/LIB 双接口模块

本文档描述 thread 从纯 CLI 改造为 CLI/LIB 双接口模块的设计。CLI 行为与 v1 完全兼容，新增 LIB 接口供 xar 直接 import 使用。

模块类型：**CLI/LIB**（见 [CLI-LIB-Module-Spec.md](../TheClaw/CLI-LIB-Module-Spec.md)）

LIB 接口由 xar 的实际需求驱动（见 [xar SPECv2.md](../xar/SPECv2.md)），不是现有 CLI 的原样 lib 化。

---

## 变更概要

| 方面 | v1 | v2 |
|------|----|----|
| 模块类型 | CLI Only | CLI/LIB |
| 入口文件 | `src/index.ts`（CLI） | `src/index.ts`（LIB）+ `src/cli.ts`（CLI） |
| 事件写入 | 仅通过 CLI `thread push` | 可通过 LIB `ThreadStore.push()` 直接调用 |
| 事件读取 | 仅通过 CLI `thread peek` | 可通过 LIB `ThreadStore.peek()` 直接调用 |
| Thread 初始化 | 仅通过 CLI `thread init` | 可通过 LIB `ThreadLib.open()` 自动初始化 |
| subscribe/dispatch/pop | CLI 完整支持 | CLI 保留；LIB 层**不暴露**（xar 不需要） |

---

## 目录结构（v2）

```
thread/
├── src/
│   ├── lib/                      ← 核心业务逻辑（无 CLI 依赖）
│   │   ├── thread-store.ts       ← ThreadStore 实现（push / peek）
│   │   ├── thread-lib.ts         ← ThreadLib 实现（open / exists）
│   │   ├── db.ts                 ← SQLite 操作（从现有 db/ 提取）
│   │   ├── event-log.ts          ← JSONL 追加写入（从现有迁移）
│   │   └── types.ts              ← 共享类型定义
│   ├── commands/                 ← CLI 子命令（薄包装，调用 lib/ 或直接操作）
│   │   ├── init.ts
│   │   ├── push.ts
│   │   ├── pop.ts
│   │   ├── peek.ts
│   │   ├── dispatch.ts
│   │   ├── subscribe.ts
│   │   ├── unsubscribe.ts
│   │   └── info.ts
│   ├── notifier-client.ts        ← CLI 层：调用 notifier CLI（保留在 src/ 根）
│   ├── help.ts                   ← CLI 层：--help / --help --verbose（保留在 src/ 根）
│   ├── index.ts                  ← LIB 入口：export lib/ 公开接口
│   └── cli.ts                    ← CLI 入口：argv 解析 + dispatch
├── vitest/
│   ├── unit/
│   ├── pbt/
│   └── fixtures/
├── package.json
├── tsconfig.json
├── tsup.config.ts                ← 双 entry 构建
├── vitest.config.ts
├── SPEC.md                       ← v1（保留）
├── SPECv2.md                     ← 本文档
└── USAGE.md
```

---

## LIB 接口定义

### 主入口（`src/index.ts`）

```typescript
export { ThreadLib } from './lib/thread-lib.js'
export { ThreadStore } from './lib/thread-store.js'
export type {
  ThreadEvent,
  ThreadEventInput,
  PeekOptions,
} from './lib/types.js'
```

---

### `ThreadLib`（工厂/管理接口）

```typescript
/**
 * ThreadLib 是 thread 操作的工厂入口。
 * 通过 open() / init() 获取 ThreadStore 实例，对具体 thread 进行操作。
 */
export class ThreadLib {
  /**
   * 打开（或自动初始化）一个 thread，返回 ThreadStore。
   * - 若目录不存在：自动创建目录结构、初始化 SQLite schema、创建空 events.jsonl
   * - 若目录已存在且是有效 thread：直接打开
   * - 若目录已存在但不是有效 thread（无 events.db）：在其中初始化（类似 git init）
   *
   * 适用场景：xar run-loop 路由消息时，按需打开或创建 per-peer thread。
   */
  open(threadPath: string): Promise<ThreadStore>

  /**
   * 显式初始化一个新 thread，返回 ThreadStore。
   * - 若目录已存在且已是有效 thread：throw ThreadError（已存在）
   * - 其余情况：创建目录结构、初始化 SQLite schema、创建空 events.jsonl
   *
   * 适用场景：xar init <agent_id> 初始化 inbox thread，语义上要求"必须是新建"。
   * 对应 CLI `thread init`。
   */
  init(threadPath: string): Promise<ThreadStore>

  /**
   * 检查指定路径是否为已初始化的 thread 目录。
   * 判断依据：目录存在且包含 events.db。
   */
  exists(threadPath: string): Promise<boolean>

  /**
   * 删除一个 thread 目录及其全部数据（events.db、events.jsonl、logs/ 等）。
   * 调用前应确保所有 ThreadStore 实例已 close()。
   * 若目录不存在，静默成功（幂等）。
   *
   * 适用场景：xar 删除 agent 时清理 inbox 和所有私有 thread。
   * 注意：这是不可逆操作，调用者负责确认。
   */
  destroy(threadPath: string): Promise<void>
}
```

---

### `ThreadStore`（per-thread 操作对象）

```typescript
/**
 * ThreadStore 封装对单个 thread 的所有操作。
 * 通过 ThreadLib.open() 获取实例。
 */
export class ThreadStore {
  /** thread 目录的绝对路径（即 thread id） */
  readonly threadPath: string

  /**
   * 写入单条事件。
   * 等价于 CLI `thread push`，但不触发 notifier dispatch。
   * xar 自己管理调度，不需要 notifier。
   */
  push(event: ThreadEventInput): Promise<ThreadEvent>

  /**
   * 批量写入事件（单个事务）。
   * 等价于 CLI `thread push --batch`，但不触发 notifier dispatch。
   */
  pushBatch(events: ThreadEventInput[]): Promise<ThreadEvent[]>

  /**
   * 读取事件（只读，不消费，不更新 consumer_progress）。
   * 等价于 CLI `thread peek`。
   */
  peek(opts: PeekOptions): Promise<ThreadEvent[]>

  /**
   * 关闭 SQLite 连接，释放资源。
   * 长期持有 ThreadStore 的调用者（如 xar run-loop）应在 agent 停止时调用。
   */
  close(): void
}
```

---

### 类型定义

```typescript
interface ThreadEventInput {
  source: string                    // thread source 地址（见 SPEC.md 4.3）
  type: 'message' | 'record'
  subtype?: string                  // 'toolcall' | 'decision' | 'error' | ...
  content: string                   // 事件内容（字符串，可含序列化 JSON）
}

interface ThreadEvent extends ThreadEventInput {
  id: number                        // SQLite AUTOINCREMENT，从 1 开始
  created_at: string                // ISO 8601 时间戳
}

interface PeekOptions {
  lastEventId: number               // 返回 id > lastEventId 的事件；0 表示从头
  limit?: number                    // 默认 100
  filter?: string                   // SQL WHERE 子句片段（同 CLI --filter）
}
```

---

## CLI 接口（v2，与 v1 完全兼容）

CLI 行为不变，`src/cli.ts` 作为薄包装。

**关键区别**：CLI 的 `push` 命令仍然触发 notifier dispatch（v1 行为保留），但 LIB 的 `ThreadStore.push()` **不触发** notifier dispatch。这是有意为之：

- CLI 用于 v1 兼容场景（notifier 驱动的调度）
- LIB 用于 xar（xar 自己管理调度，不需要 notifier）

`src/commands/push.ts` 调用 `ThreadStore.push()` 后，额外执行 notifier 触发逻辑（保持在 CLI 层，不进入 lib）。

---

## `tsup.config.ts`（v2）

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

---

## `package.json` 变更

```json
{
  "exports": {
    ".": "./dist/index.js"
  },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "bin": {
    "thread": "./dist/cli.js"
  }
}
```

---

## LIB 层设计约定

遵循 [CLI-LIB-Module-Spec.md](../TheClaw/CLI-LIB-Module-Spec.md) 的四条约定：

1. **错误处理**：lib 函数 throw `ThreadError`，CLI 层 catch 后转 exit code
2. **无 stdout 副作用**：lib 不写 stdout/stderr，CLI 层负责输出
3. **配置注入**：`ThreadLib.open()` 接受显式路径，不从环境变量读取
4. **无副作用**：import thread 时不产生任何副作用，不建立 SQLite 连接

`ThreadStore` 在 `open()` 时建立 SQLite 连接，`close()` 时释放。xar 的 run-loop 在 agent 启动时 open，agent 停止时 close，复用连接避免频繁开关。

---

## 迁移步骤

1. 新建 `src/lib/` 目录
2. 将 `src/db/` 中的 SQLite 操作提取到 `src/lib/db.ts`
3. 将 `src/event-log.ts` 迁移到 `src/lib/event-log.ts`
4. 新建 `src/lib/types.ts`，定义 `ThreadEvent`、`ThreadEventInput`、`PeekOptions`
5. 新建 `src/lib/thread-store.ts`，实现 `ThreadStore`（`push`、`pushBatch`、`peek`、`close`）
6. 新建 `src/lib/thread-lib.ts`，实现 `ThreadLib`（`open`、`init`、`exists`、`destroy`）
7. 新建 `src/index.ts`（LIB 入口），export lib/ 公开接口
8. 将现有 `src/index.ts` 重命名为 `src/cli.ts`
9. 更新 `src/commands/push.ts`：调用 `ThreadStore.push()` + 额外触发 notifier（CLI 层）
10. 更新 `src/commands/peek.ts`：调用 `ThreadStore.peek()`
11. 更新 `src/commands/init.ts`：调用 `ThreadLib.init()`
12. 更新 `tsup.config.ts` 为双 entry 构建
13. 更新 `package.json` exports/bin

---

## 不变的部分

- 所有 CLI 命令行为（`thread init/push/pop/peek/dispatch/subscribe/unsubscribe/info`）
- SQLite schema（`events`、`subscriptions`、`consumer_progress` 表）
- JSONL 事件日志格式
- Source 地址格式（见 SPEC.md 4.3）
- 错误码约定（0/1/2）
- 环境变量（无全局变量，路径由调用者显式指定）
