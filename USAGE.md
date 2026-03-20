# USAGE: thread

## 安装

```bash
npm run build && npm link
```

## 核心概念

每个 thread 是一个目录，通过 `thread init <path>` 初始化（类似 `git init`）。路径即 thread ID，天然唯一。所有命令通过 `--thread <path>` 指定目标目录。

---

## 初始化

### `thread init <path>`

初始化一个新的 thread 目录。

```bash
thread init /path/to/my-thread
```

- 创建目录结构（`run/`、`logs/`）
- 初始化 `events.db`（SQLite，WAL 模式）
- 创建空的 `events.jsonl`
- 若目录已是有效 thread 目录，报错退出（退出码 1）

---

## 事件操作

### `thread push`

向 thread 推送一条事件。

```bash
thread push \
  --thread <path> \
  --source <name> \
  --type <type> \
  --content <data> \
  [--subtype <subtype>]
```

示例：

```bash
thread push \
  --thread /tmp/my-thread \
  --source agent-007 \
  --type message \
  --content "task completed"
```

批量模式（从 stdin 读 NDJSON，每行一个事件对象）：

```bash
cat events.jsonl | thread push --thread /tmp/my-thread --batch
```

批量模式下 stdin 每行格式：

```json
{"source": "agent-007", "type": "record", "subtype": "toolcall", "content": "..."}
```

push 成功后自动触发 `notifier` 调度 dispatch（幂等，相同 task-id 不重复排队）。

### `thread pop`

从 thread 取出事件（NDJSON 输出到 stdout）。

```bash
thread pop \
  --thread <path> \
  --consumer <id> \
  --last-event-id <id> \
  [--limit <n>]
```

- `--last-event-id`：上次已处理完毕的最大 event id；首次传 `0` 表示从头消费
- `--limit`：默认 100
- consumer 不存在于 `subscriptions` 时报错退出（退出码 1）

典型消费循环：

```bash
# 首次消费
thread pop --thread /tmp/my-thread --consumer worker-1 --last-event-id 0

# 处理完事件后，传入已处理的最大 id
thread pop --thread /tmp/my-thread --consumer worker-1 --last-event-id 42
```

无新事件时输出为空（无任何行）。

### `thread peek`

只读查询事件（不更新消费进度）。适用于 agent 构建 LLM context 时从 thread 读取最近消息等"读取但不消费"的场景。

```bash
thread peek \
  --thread <path> \
  --last-event-id <id> \
  [--limit <n>] \
  [--filter <sql-where>]
```

- `--last-event-id`：返回 id > 此值的事件；传 `0` 从头读取
- `--limit`：默认 100
- `--filter`：可选的 SQL WHERE 子句片段
- 不需要 `--consumer`，不更新 `consumer_progress`，不要求在 `subscriptions` 中注册

示例：

```bash
# 读取所有事件
thread peek --thread /tmp/my-thread --last-event-id 0

# 只读取 message 类型
thread peek --thread /tmp/my-thread --last-event-id 0 --filter "type = 'message'"

# 从 id=42 之后读取最多 10 条
thread peek --thread /tmp/my-thread --last-event-id 42 --limit 10
```

与 `pop` 的区别：`peek` 是纯只读查询，不需要 consumer 注册，不更新消费进度。

---

## 订阅管理

### `thread subscribe`

注册一个 consumer 订阅。

```bash
thread subscribe \
  --thread <path> \
  --consumer <id> \
  --handler <cmd> \
  [--filter <sql-where>]
```

示例：

```bash
# 订阅全部事件
thread subscribe \
  --thread /tmp/my-thread \
  --consumer worker-1 \
  --handler "pai chat --session /tmp/worker-1.jsonl --provider openai"

# 只订阅 message 类型事件
thread subscribe \
  --thread /tmp/my-thread \
  --consumer worker-2 \
  --handler "my-handler --thread /tmp/my-thread --consumer worker-2" \
  --filter "type = 'message'"

# 订阅特定 source 的 record 事件
thread subscribe \
  --thread /tmp/my-thread \
  --consumer monitor \
  --handler "my-monitor" \
  --filter "source = 'agent-007' AND type = 'record'"
```

`--filter` 为 SQL WHERE 子句片段，施加在 `events` 表上。为空时订阅全部事件。consumer 已存在时报错退出（退出码 1，提示先 `thread unsubscribe`）。

### `thread unsubscribe`

删除一个 consumer 订阅。

```bash
thread unsubscribe --thread <path> --consumer <id>
```

不存在时报错退出（退出码 1）。

---

## 查看状态

### `thread info`

输出 thread 摘要：事件总数、订阅列表、各 consumer 消费进度。

```bash
thread info --thread <path>
thread info --thread <path> --json
```

---

## 内部命令

### `thread dispatch`（Internal）

由 `notifier` 自动调用，无需手动执行。

```bash
thread dispatch --thread <path>
```

遍历所有订阅，对有未消费事件的 consumer 尝试加文件锁并以分离模式 spawn `handler_cmd`。已在运行的 consumer（锁被占用）会被跳过。

---

## 数据目录结构

```
<thread-dir>/
├── events.db                        # SQLite 数据库（WAL 模式）
├── events.jsonl                     # 只追加的事件日志，供调试浏览
├── events-<YYYYMMDD-HHmmss>.jsonl   # 轮换后的历史事件日志
├── run/                             # Consumer 运行时 .lock 文件
└── logs/
    ├── thread.log                   # 当前运行日志
    └── thread-<YYYYMMDD-HHmmss>.log # 轮换后的历史日志
```

日志和 JSONL 超过 10000 行时自动轮换。

---

## Event 结构

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | INTEGER | 自增主键，由 SQLite 生成 |
| `created_at` | TEXT | ISO 8601，写入时自动生成 |
| `source` | TEXT | 事件来源标识 |
| `type` | TEXT | 事件类型 |
| `subtype` | TEXT \| null | 事件子类型 |
| `content` | TEXT | 事件内容（字符串，内部可为序列化 JSON） |

### Event Type 枚举

| type | subtype | 说明 |
|------|---------|------|
| `message` | null | Actor 间通信消息 |
| `record` | `toolcall` | 工具调用的原子行为记录 |
| `record` | `decision` | 决策过程记录 |

---

## 退出码

| 退出码 | 含义 |
|--------|------|
| `0` | 成功 |
| `1` | 一般逻辑错误（订阅已存在、consumer 不存在等） |
| `2` | 参数/语法错误（缺少必需参数等） |

## 错误输出格式

```
Error: <什么错了> - <怎么修>
```

`--json` 模式下：

```json
{"error": "...", "suggestion": "..."}
```

---

## 帮助

```bash
thread --help
thread --help --verbose    # 显示退出码说明
thread init --help
thread push --help
thread pop --help
thread subscribe --help
thread --version
```
