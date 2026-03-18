# SPEC: thread

`thread` 是一个用于管理和操作事件队列（Threads）的 CLI 工具。它基于 SQLite 存储事件和订阅状态，并利用 `notifier` 实现异步、非阻塞的任务调度。

## 决策记录

1. **Thread 目录即 Thread ID**：每个 thread 的全部数据存放在一个目录下，通过 `thread init <path>` 初始化（类似 `git init`），后续命令通过 `--thread <path>` 指定。路径经 `path.resolve()` 规范化后作为 thread id，天然唯一、无需注册。清理时直接删除目录即可，无需专用清理命令。
2. **直接使用 SQLite**：不依赖 xdb 服务，使用 `better-sqlite3` 直接操作。每个 thread 目录下一个独立的 `events.db`，数据隔离。
3. **双轨存储**：SQLite 作为查询/订阅状态的主存储；同时维护一份 `events.jsonl`（只追加），供人类调试浏览，无需 SQLite 客户端。
4. **Event Structure**：见第 4 节。凡需要在订阅过滤/分发前判断的字段，统一提到 event 顶层结构中。
5. **Batch 支持**：`push --batch` 从 stdin 读 NDJSON（每行一个 payload）；`pop --limit` 默认 100。
6. **Filter 设计**：订阅时通过 `--filter` 指定 SQL WHERE 子句片段（施加在 `events` 表上）。filter 同时作用于 dispatch（决定是否触发 handler）和 pop（consumer 只拿到匹配的事件）。调用者均为内部命令，无用户输入注入风险。

## 1. 定位 (Role)

- **存储管理**：管理事件（Events）的持久化存储（SQLite + JSONL）。
- **订阅分发**：管理 Consumer 订阅关系，并根据 `push` 事件触发 `notifier` 指令。
- **状态快照**：记录 Consumer 的消费进度（ACK 状态）以便监控。

## 2. 技术栈与项目结构

遵循 `pai` repo 约定：

- **TypeScript + ESM** (Node 20+)
- **构建**: tsup (ESM, shebang banner)
- **测试**: vitest (unit, pbt, fixtures)
- **CLI 解析**: commander
- **SQLite**: better-sqlite3

```
thread/
├── src/
│   ├── index.ts              # 入口，CLI 解析与分发
│   ├── commands/             # 子命令实现
│   │   ├── init.ts
│   │   ├── push.ts
│   │   ├── pop.ts
│   │   ├── dispatch.ts
│   │   ├── subscribe.ts
│   │   ├── unsubscribe.ts
│   │   └── info.ts
│   ├── db/
│   │   ├── init.ts           # SQLite 初始化、WAL 模式、schema 迁移
│   │   └── queries.ts        # 封装所有 SQL 操作
│   ├── event-log.ts          # JSONL 追加写入工具
│   ├── notifier-client.ts    # 调用 notifier CLI 的核心逻辑
│   ├── help.ts               # --help / --help --verbose 输出
│   ├── logger.ts             # 运行日志工具
│   └── types.ts              # 共享类型定义
├── vitest/
│   ├── unit/
│   ├── pbt/
│   ├── fixtures/
│   └── helpers/
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── vitest.config.ts
├── SPEC.md
└── USAGE.md
```

## 3. 数据目录规范

每个 thread 的数据完全自包含于其目录下：

```
<thread-dir>/          # 即 thread id（path.resolve() 后的绝对路径）
├── events.db          # SQLite 数据库（WAL 模式）
├── events.jsonl       # 只追加的事件日志，供调试浏览
├── events-<timestamp>.jsonl  # 轮换后的历史事件日志
├── run/               # Consumer 运行时 .lock 文件
└── logs/
    ├── thread.log     # 当前运行日志
    └── thread-<timestamp>.log  # 轮换后的历史日志
```

`<thread-dir>` 由调用者在命令行通过 `--thread <path>` 指定，`thread` 工具在首次写入时自动创建目录结构。

## 4. Event Structure

每条事件包含以下字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | INTEGER | 自增主键，由 SQLite 生成 |
| `created_at` | TEXT | ISO 8601，写入时自动生成 |
| `source` | TEXT | 事件来源标识（产生事件的 actor/组件名） |
| `type` | TEXT | 事件类型，见下方枚举 |
| `subtype` | TEXT \| null | 事件子类型，见下方枚举 |
| `content` | TEXT | 事件内容，字符串（内部可为序列化 JSON，thread 不解析） |

`source`、`type`、`subtype` 是可用于订阅过滤的字段，统一置于顶层结构。

### Event Type 枚举

| type | subtype | 说明 |
|------|---------|------|
| `message` | null | Actor 间通信消息 |
| `record` | `toolcall` | Actor 执行工具调用的原子行为记录 |
| `record` | `decision` | Actor 决策过程记录，供外部可见性 |

subtype 可随需求扩展（如 artifact 生命周期事件、thread 状态事件等）。

## 5. 数据模型 (SQLite)

数据库开启 `PRAGMA journal_mode=WAL;` 以支持高性能并发读写。

### 5.1 `events` 表

```sql
CREATE TABLE events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  source     TEXT    NOT NULL,
  type       TEXT    NOT NULL,
  subtype    TEXT,
  content    TEXT    NOT NULL
);
CREATE INDEX idx_events_source ON events(source);
CREATE INDEX idx_events_type   ON events(type);
```

### 5.2 `subscriptions` 表

```sql
CREATE TABLE subscriptions (
  consumer_id  TEXT NOT NULL,
  handler_cmd  TEXT NOT NULL,
  filter       TEXT,         -- 可选的 SQL WHERE 子句片段，施加在 events 表上
                             -- 例: "type = 'message'" 或 "source = 'agent-007' AND type = 'record'"
                             -- 为 null 时表示订阅全部事件
  PRIMARY KEY (consumer_id)
);
```

### 5.3 `consumer_progress` 表

```sql
CREATE TABLE consumer_progress (
  consumer_id   TEXT NOT NULL PRIMARY KEY,
  last_acked_id INTEGER NOT NULL DEFAULT 0,  -- 0 表示尚未消费任何事件；SQLite AUTOINCREMENT 从 1 开始，故 id > 0 可取到全部事件
  updated_at    TEXT NOT NULL
);
```

## 6. CLI 子命令规范

所有命令通过 `--thread <path>` 指定目标 thread 目录（必需）。`push`、`pop`、`subscribe`、`info` 支持 `--json` 输出；`unsubscribe`、`dispatch` 不输出结构化数据，不支持 `--json`。

thread 目录不存在或不是有效 thread 目录时，除 `thread init` 外所有命令均报错退出（退出码 1，提示先运行 `thread init <path>`）。判断是否为有效 thread 目录的依据：目录存在且包含 `events.db`。

### 6.1 核心操作

#### `thread init`

**参数**：`<path>`（位置参数，必需，目标目录路径）

**行为**：
1. 创建目录结构（`run/`、`logs/`）。
2. 初始化 `events.db`（建表、WAL 模式）。
3. 创建空的 `events.jsonl`。
4. 若目录已存在且已是有效 thread 目录，报错退出（退出码 1）。若目录已存在但不是 thread 目录，在其中初始化（类似 `git init`）。

#### `thread push`

**参数**：
- `--thread <path>`（必需）
- `--source <name>`（必需）
- `--type <type>`（必需）
- `--subtype <subtype>`（可选）
- `--content <data>`（必需，单条模式）
- `--batch`（可选，从 stdin 读 NDJSON，每行一个完整 event 对象，忽略 `--content`）

**行为**：
1. 将事件插入 `events` 表（事务）。
2. 同步 append 到 `events.jsonl`。
3. 触发调度：执行 `notifier task add --author <source> --task-id "dispatch-<thread_path_slug>" --command "thread dispatch --thread <path>"`。
   - `<source>` 即本次 push 的 `--source` 参数值
   - `<thread_path_slug>` 为 thread 路径将所有非字母数字字符替换为连字符后的结果，超过 40 字符时取前 32 字符加 `-` 加路径 sha1 前 6 位，例如 `/home/user/my-project/thread` → `home-user-my-project-thread`
4. 若 `notifier` 返回退出码 `1`（任务已存在），视为成功正常退出（dispatch 已在队列中）。

`--batch` 模式：stdin 每行为一个 JSON 对象，包含 `source`、`type`、`content` 字段（`subtype` 可选）。所有行在单个事务中批量插入。batch 模式下仍只触发一次 notifier dispatch（以最后一条事件的 `source` 作为 `--author`）。

#### `thread pop`

**参数**：
- `--thread <path>`（必需）
- `--consumer <id>`（必需）
- `--last-event-id <id>`（必需，上次已**处理完毕**的最大 event id；首次传 0 表示从头消费，SQLite id 从 1 起分配）
- `--limit <n>`（可选，默认 100）

**行为**：
1. 查询该 consumer 的 `filter`（从 `subscriptions` 表）。若 consumer 不存在于 `subscriptions`，报错退出（退出码 1）。
2. 更新 `consumer_progress` 中的 `last_acked_id` 为 `--last-event-id` 参数值（upsert；首次 pop 时该记录不存在，正常插入）。
3. 返回：
   ```sql
   SELECT * FROM events
   WHERE id > <last-event-id>
     AND (<filter 子句，为 null 时省略>)
   ORDER BY id ASC LIMIT <limit>
   ```
4. 输出 NDJSON 到 stdout（每行一个 event）。若无新事件，输出空（无任何行）。

> **ACK 语义**：`--last-event-id` 是上一批**已处理完毕**的最大 event id，而非本次将要取回的起点。Consumer 的典型处理流程为：`pop(last=0)` → 处理事件 → `pop(last=<已处理最大id>)` → 处理事件 → … → 直到返回空则退出。若 consumer 在处理中途 crash，下次重启时重传上次已确认的 id，未处理的事件会被重新取回（at-least-once 语义）。

#### `thread dispatch`（Internal）

**参数**：`--thread <path>`（必需）

**行为**：
1. 遍历 `subscriptions` 表中所有订阅。
2. 对每个 consumer，从 `consumer_progress` 取 `last_acked_id`（若无记录则视为 0）。查询是否存在未消费的、符合 filter 条件的事件：
   ```sql
   SELECT 1 FROM events
   WHERE id > <last_acked_id>
     AND (<filter 子句，为 null 时省略>)
   LIMIT 1
   ```
   若无匹配事件，跳过该 consumer。
3. 尝试对 `run/<consumer_id>.lock` 加互斥锁（跨平台方案，见下方说明）。
4. 若加锁成功，以 `shell: true` 分离模式 spawn `handler_cmd`（作为单行 shell 命令执行，支持管道等 shell 特性）；若加锁失败（consumer 正在运行），跳过。
5. 记录调度详情到日志。

> **文件锁跨平台方案**：优先使用通用 Node.js 方案（如 `proper-lockfile` 或手动 `O_EXCL` 原子创建锁文件）。若无合适的通用方案，则分别实现 Linux（`flock`）和 macOS/Windows 的锁逻辑，统一封装在 `src/flock-utils.ts` 中，对外暴露 `tryLock(path): boolean` / `unlock(path): void` 接口。

> **注意**：filter 同时决定 dispatch 是否触发 handler，以及 `pop` 返回的事件范围（consumer 只拿到它关心的事件）。

### 6.2 管理操作

#### `thread subscribe`

**参数**：
- `--thread <path>`（必需）
- `--consumer <id>`（必需）
- `--handler <cmd>`（必需）
- `--filter <sql-where>`（可选，SQL WHERE 子句片段，如 `"type = 'message'"`，为空时订阅全部事件）

**行为**：插入 `subscriptions`。若 `consumer_id` 已存在则报错退出（退出码 1，提示先 `thread unsubscribe` 再重新订阅）。

> **注意**：`handler_cmd` 由订阅者自行构造，建议在命令中包含 `--thread <path>` 和 `--consumer <id>` 参数（或通过其他方式确保 handler 能定位到对应的 thread 和 consumer）。

#### `thread unsubscribe`

**参数**：`--thread <path>`（必需），`--consumer <id>`（必需）

**行为**：删除对应订阅。不存在时报错退出（退出码 1）。

#### `thread info`

**参数**：`--thread <path>`（必需），`--json`（可选）

**行为**：输出 thread 摘要，包括事件总数、订阅列表、各 consumer 的消费进度。

## 7. 机器可读输出与错误处理

### 7.1 退出码

| 退出码 | 含义 |
|--------|------|
| `0` | 成功 |
| `1` | 一般逻辑错误（订阅已存在、文件不存在等） |
| `2` | 参数/语法错误（缺少必需参数、类型非法等） |

### 7.2 错误输出

stderr 输出格式：`Error: <什么错了> - <怎么修>`

`--json` 模式下：`{"error": "...", "suggestion": "..."}`

## 8. 日志规范

日志文件：`<thread-dir>/logs/thread.log`

**记录内容**：
- `push` 成功及 notifier 调用状态
- `dispatch` 扫描结果：发现哪些 consumer、哪些因加锁失败跳过、哪些成功启动
- SQLite 致命错误

**轮换策略**：超过 10000 行时自动轮换，旧文件重命名为 `thread-<YYYYMMDD-HHmmss>.log`，新建空文件继续写入。

**日志行格式**：
```
[2026-03-18T10:30:00.123Z] [INFO] push: source=agent-007 type=message id=42
[2026-03-18T10:30:00.200Z] [INFO] dispatch: consumer=worker-1 spawned handler_cmd="pai chat ..."
[2026-03-18T10:30:00.201Z] [INFO] dispatch: consumer=worker-2 skipped (lock held)
```

## 9. JSONL 事件日志轮换

`events.jsonl` 超过 10000 行时自动轮换（在下次 push 时检查），旧文件重命名为 `events-<YYYYMMDD-HHmmss>.jsonl`。SQLite 中的事件数据不受影响。

## 10. 幂等性与安全性

1. **Push**：非幂等，每次调用生成新 event id。但触发的 dispatch 调度在 notifier 层是幂等的（相同 task-id 不重复排队）。
2. **Dispatch 安全性**：文件锁确保同一 consumer 不会被重复启动。
3. **原子性**：所有数据库写操作包裹在事务中。batch push 整批在单个事务中完成。

## 11. 环境变量

| 变量 | 说明 |
|------|------|
| 无全局 HOME 变量 | thread 目录由调用者通过 `--thread <path>` 显式指定 |
