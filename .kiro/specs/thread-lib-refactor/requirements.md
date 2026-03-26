# 需求文档：thread CLI/LIB 双接口改造

## 简介

将 thread 从纯 CLI 模块改造为 CLI/LIB 双接口模块。新增 `src/lib/` 层，暴露 `ThreadLib` 和 `ThreadStore` 供 xar（agent runtime daemon）直接 import 使用，同时保持所有 CLI 命令行为与 v1 完全兼容。

## 词汇表

- **Thread**：基于 SQLite 的事件队列目录，包含 `events.db`、`events.jsonl`、`logs/`、`run/` 子目录
- **ThreadLib**：工厂/管理接口，负责 thread 目录的创建、打开、检查和删除
- **ThreadStore**：per-thread 操作对象，封装单个 thread 的读写操作
- **ThreadEvent**：已持久化的事件，含 `id`（自增主键）和 `created_at`（ISO 8601 时间戳）
- **ThreadEventInput**：写入事件的输入结构，不含 `id` 和 `created_at`
- **PeekOptions**：`ThreadStore.peek()` 的查询参数
- **ThreadError**：lib 层抛出的自定义错误类，携带 `code` 字段
- **LIB 入口**：`src/index.ts`，export lib 公开接口，import 时无副作用
- **CLI 入口**：`src/cli.ts`，原 `src/index.ts` 改名，负责 argv 解析和命令分发
- **双 entry 构建**：tsup 同时构建 `dist/index.js`（LIB，含 dts）和 `dist/cli.js`（CLI，含 shebang）

---

## 需求

### 需求 1：ThreadLib.open() — 按需打开或创建 thread

**用户故事**：作为 xar run-loop，我希望通过 `ThreadLib.open()` 按需打开或自动创建 per-peer thread，以便在不预先初始化的情况下路由消息。

#### 验收标准

1. WHEN 调用 `ThreadLib.open(threadPath)` 且目标目录不存在，THE ThreadLib SHALL 自动创建目录结构（含 `logs/`、`run/` 子目录）、初始化 SQLite schema、创建空 `events.jsonl`，并返回已连接的 `ThreadStore` 实例
2. WHEN 调用 `ThreadLib.open(threadPath)` 且目标目录已存在且包含 `events.db`，THE ThreadLib SHALL 直接打开该 thread 并返回已连接的 `ThreadStore` 实例，不修改现有数据
3. WHEN 调用 `ThreadLib.open(threadPath)` 且目标目录已存在但不包含 `events.db`，THE ThreadLib SHALL 在该目录中初始化 thread（创建 `events.db`、`events.jsonl`）并返回已连接的 `ThreadStore` 实例
4. THE ThreadLib.open() SHALL 是幂等操作：对同一路径多次调用均成功，不破坏已有数据

---

### 需求 2：ThreadLib.init() — 强制新建 thread

**用户故事**：作为 xar init 命令，我希望通过 `ThreadLib.init()` 强制新建 inbox thread，以便在语义上确保"必须是新建"，已存在则报错。

#### 验收标准

1. WHEN 调用 `ThreadLib.init(threadPath)` 且目标路径不存在有效 thread（`events.db` 不存在），THE ThreadLib SHALL 创建完整目录结构、初始化 SQLite schema、创建空 `events.jsonl`，并返回已连接的 `ThreadStore` 实例
2. WHEN 调用 `ThreadLib.init(threadPath)` 且目标路径已存在有效 thread（`events.db` 已存在），THE ThreadLib SHALL throw `ThreadError`，错误 `code` 为 `THREAD_ALREADY_EXISTS`
3. IF `ThreadLib.init()` 抛出错误，THEN THE ThreadLib SHALL 不修改目标路径下的任何现有文件

---

### 需求 3：ThreadLib.exists() — 检查 thread 是否已初始化

**用户故事**：作为 xar，我希望通过 `ThreadLib.exists()` 检查 thread 是否已初始化，以便在操作前做条件判断。

#### 验收标准

1. WHEN 调用 `ThreadLib.exists(threadPath)` 且目标目录存在且包含 `events.db`，THE ThreadLib SHALL 返回 `true`
2. WHEN 调用 `ThreadLib.exists(threadPath)` 且目标目录不存在或不包含 `events.db`，THE ThreadLib SHALL 返回 `false`
3. THE ThreadLib.exists() SHALL 不修改文件系统，不建立 SQLite 连接

---

### 需求 4：ThreadLib.destroy() — 删除 thread 目录

**用户故事**：作为 xar 删除 agent 的流程，我希望通过 `ThreadLib.destroy()` 清理 inbox 和所有私有 thread 目录，以便彻底移除 agent 数据。

#### 验收标准

1. WHEN 调用 `ThreadLib.destroy(threadPath)` 且目标目录存在，THE ThreadLib SHALL 递归删除该目录及其全部内容（`events.db`、`events.jsonl`、`logs/`、`run/` 等）
2. WHEN 调用 `ThreadLib.destroy(threadPath)` 且目标目录不存在，THE ThreadLib SHALL 静默成功（幂等，不抛出错误）
3. THE ThreadLib.destroy() SHALL 在目录删除后使 `ThreadLib.exists(threadPath)` 返回 `false`

---

### 需求 5：ThreadStore.push() — 写入单条事件

**用户故事**：作为 xar run-loop，我希望通过 `ThreadStore.push()` 写入单条事件，以便将入站消息和 LLM 回复持久化到 thread。

#### 验收标准

1. WHEN 调用 `ThreadStore.push(event)` 且 `event` 包含有效的 `source`、`type`、`content` 字段，THE ThreadStore SHALL 将事件写入 SQLite `events` 表并追加到 `events.jsonl`，返回含 `id` 和 `created_at` 的 `ThreadEvent`
2. WHEN 调用 `ThreadStore.push(event)`，THE ThreadStore SHALL 不触发 notifier dispatch（与 CLI `thread push` 的区别）
3. THE ThreadStore.push() SHALL 返回的 `ThreadEvent.id` 为 SQLite AUTOINCREMENT 分配的正整数，从 1 开始递增
4. WHEN 调用 `ThreadStore.push(event)` 且 `event.subtype` 未提供，THE ThreadStore SHALL 将 `subtype` 存储为 `null`

---

### 需求 6：ThreadStore.pushBatch() — 批量写入事件

**用户故事**：作为 xar run-loop，我希望通过 `ThreadStore.pushBatch()` 在单个事务中批量写入多条事件，以便高效持久化 LLM 回复的多条消息。

#### 验收标准

1. WHEN 调用 `ThreadStore.pushBatch(events)` 且 `events` 为非空数组，THE ThreadStore SHALL 在单个 SQLite 事务中写入所有事件，并返回对应的 `ThreadEvent[]`，顺序与输入一致
2. WHEN 调用 `ThreadStore.pushBatch(events)` 且 `events` 为空数组，THE ThreadStore SHALL 返回空数组，不修改数据库
3. THE ThreadStore.pushBatch() SHALL 不触发 notifier dispatch
4. WHEN `ThreadStore.pushBatch()` 事务中任意事件写入失败，THEN THE ThreadStore SHALL 回滚整个事务，不写入任何事件

---

### 需求 7：ThreadStore.peek() — 只读查询事件

**用户故事**：作为 xar context 构建器，我希望通过 `ThreadStore.peek()` 读取最近的事件，以便组装 LLM 上下文。

#### 验收标准

1. WHEN 调用 `ThreadStore.peek({ lastEventId: 0 })`，THE ThreadStore SHALL 返回从第一条事件开始的结果，按 `id` 升序排列
2. WHEN 调用 `ThreadStore.peek({ lastEventId: N })` 且 N > 0，THE ThreadStore SHALL 仅返回 `id > N` 的事件
3. WHEN 调用 `ThreadStore.peek({ limit: L })`，THE ThreadStore SHALL 最多返回 L 条事件；未指定 `limit` 时默认返回最多 100 条
4. WHEN 调用 `ThreadStore.peek({ filter: sqlWhere })`，THE ThreadStore SHALL 将 `filter` 作为 SQL WHERE 子句片段附加到查询条件
5. THE ThreadStore.peek() SHALL 不修改数据库状态（不更新 `consumer_progress`）

---

### 需求 8：ThreadStore.close() — 释放 SQLite 连接

**用户故事**：作为 xar agent 停止流程，我希望通过 `ThreadStore.close()` 释放 SQLite 连接，以便避免资源泄漏。

#### 验收标准

1. WHEN 调用 `ThreadStore.close()`，THE ThreadStore SHALL 关闭底层 SQLite 连接，释放文件锁
2. WHEN 在 `ThreadStore.close()` 之后调用任意写入或读取方法，THE ThreadStore SHALL throw 错误（连接已关闭）

---

### 需求 9：LIB 层设计约定

**用户故事**：作为 xar 的开发者，我希望 thread lib 遵循 CLI/LIB 双接口模块约定，以便安全地在 daemon 进程中 import 使用。

#### 验收标准

1. THE LIB 入口（`src/index.ts`）SHALL 仅 export `ThreadLib`、`ThreadStore`、`ThreadEvent`、`ThreadEventInput`、`PeekOptions` 类型，import 时不产生任何副作用（不建立连接、不读写文件、不注册信号处理）
2. THE ThreadLib 和 ThreadStore SHALL 在发生错误时 throw `ThreadError`，不调用 `process.exit()`，不写 `stdout`/`stderr`
3. THE ThreadLib 和 ThreadStore SHALL 接受显式路径参数，不从环境变量或全局状态读取配置
4. WHERE `ThreadStore` 实例被长期持有，THE ThreadStore SHALL 复用同一 SQLite 连接，不在每次操作时重新打开

---

### 需求 10：CLI 兼容性

**用户故事**：作为 thread v1 的现有用户，我希望所有 CLI 命令行为与 v1 完全兼容，以便无需修改现有脚本和集成。

#### 验收标准

1. THE CLI SHALL 支持所有 v1 命令：`init`、`push`、`pop`、`peek`、`dispatch`、`subscribe`、`unsubscribe`、`info`，参数和输出格式不变
2. WHEN 执行 CLI `thread push`，THE CLI SHALL 在写入事件后触发 notifier dispatch（保持 v1 行为）
3. WHEN 执行 CLI `thread init <path>`，THE CLI SHALL 调用 `ThreadLib.init()` 实现初始化逻辑，若目录已是有效 thread 则输出错误并以退出码 1 退出
4. WHEN 执行 CLI `thread peek`，THE CLI SHALL 调用 `ThreadStore.peek()` 实现查询逻辑，输出 NDJSON 到 stdout
5. THE CLI 入口（`src/cli.ts`）SHALL 保留 EPIPE 处理、`exitOverride()`、错误码映射（参数错误 → 2，运行时错误 → 1）

---

### 需求 11：tsup 双 entry 构建

**用户故事**：作为模块发布者，我希望 tsup 同时构建 LIB 入口和 CLI 入口，以便 xar 可以 import LIB，用户可以使用 CLI。

#### 验收标准

1. THE 构建系统 SHALL 输出 `dist/index.js`（LIB 入口，无 shebang，含 TypeScript 类型声明 `dist/index.d.ts`）
2. THE 构建系统 SHALL 输出 `dist/cli.js`（CLI 入口，含 `#!/usr/bin/env node` shebang，不生成类型声明）
3. THE 构建系统 SHALL 两个 entry 均输出 ESM 格式，target 为 node22

---

### 需求 12：package.json exports 字段

**用户故事**：作为 xar 的开发者，我希望 `package.json` 包含正确的 `exports`、`main`、`types` 字段，以便通过 `import { ThreadLib } from '@theclawlab/thread'` 直接使用 LIB。

#### 验收标准

1. THE package.json SHALL 包含 `"exports": { ".": "./dist/index.js" }` 字段
2. THE package.json SHALL 包含 `"main": "./dist/index.js"` 字段
3. THE package.json SHALL 包含 `"types": "./dist/index.d.ts"` 字段
4. THE package.json `"bin"` 字段 SHALL 指向 `"./dist/cli.js"`
