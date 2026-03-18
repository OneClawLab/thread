# 需求文档：thread-core

## 简介

`thread` 是一个基于 SQLite 的事件队列 CLI 工具，用于管理事件的持久化存储、Consumer 订阅分发和消费进度追踪。每个 thread 是一个自包含目录，通过 `thread init <path>` 初始化，后续所有命令通过 `--thread <path>` 指定目标目录。工具利用 `notifier` 实现异步、非阻塞的任务调度，支持 at-least-once 消费语义。

## 词汇表

- **Thread**：一个事件队列实例，对应文件系统上的一个目录，包含 `events.db`、`events.jsonl`、`run/`、`logs/` 等子结构。
- **Thread_Dir**：thread 目录的绝对路径（经 `path.resolve()` 规范化），同时作为 thread 的唯一标识。
- **Event**：一条事件记录，包含 `id`、`created_at`、`source`、`type`、`subtype`、`content` 字段。
- **Consumer**：订阅 thread 事件的消费者，由 `consumer_id` 唯一标识。
- **Handler_Cmd**：Consumer 注册的处理命令，由 dispatch 以分离模式 spawn 执行。
- **Filter**：SQL WHERE 子句片段，施加在 `events` 表上，用于过滤 Consumer 关心的事件。
- **DB**：每个 thread 目录下的 `events.db` SQLite 数据库。
- **JSONL_Log**：`events.jsonl`，只追加的事件日志文件，供人类调试浏览。
- **Notifier**：外部 CLI 工具，用于幂等地调度 dispatch 任务。
- **Lock_File**：`run/<consumer_id>.lock`，用于防止同一 Consumer 被重复启动的互斥锁文件。
- **CLI**：`thread` 命令行工具本身。

---

## 需求

### 需求 1：项目初始化（thread init）

**用户故事**：作为开发者，我希望通过 `thread init <path>` 初始化一个新的 thread 目录，以便在指定位置创建独立的事件队列存储结构。

#### 验收标准

1. WHEN 用户执行 `thread init <path>` 且目标目录不存在，THE CLI SHALL 创建目录及其子目录 `run/` 和 `logs/`，初始化 `events.db`（建表、开启 WAL 模式），并创建空的 `events.jsonl`，退出码为 0。
2. WHEN 用户执行 `thread init <path>` 且目标目录已存在但不包含 `events.db`，THE CLI SHALL 在该目录中执行初始化（创建缺失的子目录和文件），退出码为 0。
3. WHEN 用户执行 `thread init <path>` 且目标目录已存在且包含 `events.db`（已是有效 thread 目录），THE CLI SHALL 输出错误信息到 stderr 并以退出码 1 退出。
4. WHEN `thread init` 成功完成，THE DB SHALL 包含 `events`、`subscriptions`、`consumer_progress` 三张表及对应索引，并开启 WAL 模式。
5. WHEN `thread init` 成功完成，THE DB SHALL 在 `events` 表上创建 `idx_events_source` 和 `idx_events_type` 索引。

---

### 需求 2：事件推送（thread push）

**用户故事**：作为事件生产者，我希望通过 `thread push` 将事件写入 thread，以便 Consumer 能够订阅和处理这些事件。

#### 验收标准

1. WHEN 用户执行 `thread push --thread <path> --source <s> --type <t> --content <c>`，THE CLI SHALL 在单个事务中将事件插入 `events` 表，并同步追加到 `events.jsonl`，退出码为 0。
2. WHEN 事件成功插入，THE DB SHALL 为该事件分配自增 `id` 并自动填充 `created_at` 为 ISO 8601 格式的当前时间。
3. WHEN 用户执行 `thread push` 且提供 `--subtype <st>`，THE CLI SHALL 将 `subtype` 字段写入事件记录。
4. WHEN 用户执行 `thread push` 且未提供 `--subtype`，THE CLI SHALL 将 `subtype` 字段存储为 null。
5. WHEN 事件插入成功，THE CLI SHALL 调用 `notifier task add --author <source> --task-id "dispatch-<thread_path_slug>" --command "thread dispatch --thread <path>"`，其中 `<thread_path_slug>` 为 thread 路径规范化后的结果。
6. WHEN notifier 返回退出码 1（任务已存在），THE CLI SHALL 视为成功并以退出码 0 退出。
7. WHEN 用户执行 `thread push --batch`，THE CLI SHALL 从 stdin 逐行读取 NDJSON，每行包含 `source`、`type`、`content` 字段（`subtype` 可选），在单个事务中批量插入所有事件。
8. WHEN `--batch` 模式下所有事件插入成功，THE CLI SHALL 仅触发一次 notifier dispatch，以最后一条事件的 `source` 作为 `--author`。
9. WHEN `--thread <path>` 指定的目录不是有效 thread 目录，THE CLI SHALL 输出错误信息到 stderr 并以退出码 1 退出。
10. WHEN `events.jsonl` 超过 10000 行，THE CLI SHALL 在下次 push 时将旧文件重命名为 `events-<YYYYMMDD-HHmmss>.jsonl` 并创建新的空 `events.jsonl`。

---

### 需求 3：事件消费（thread pop）

**用户故事**：作为 Consumer，我希望通过 `thread pop` 获取未处理的事件，以便按顺序处理并维护消费进度。

#### 验收标准

1. WHEN 用户执行 `thread pop --thread <path> --consumer <id> --last-event-id <n>`，THE CLI SHALL 查询 `subscriptions` 表获取该 consumer 的 filter。
2. WHEN consumer 不存在于 `subscriptions` 表，THE CLI SHALL 输出错误信息到 stderr 并以退出码 1 退出。
3. WHEN pop 执行，THE CLI SHALL 将 `consumer_progress` 中该 consumer 的 `last_acked_id` upsert 为 `--last-event-id` 参数值。
4. WHEN pop 执行，THE CLI SHALL 查询 `id > <last-event-id>` 且符合 filter 条件的事件，按 `id` 升序排列，最多返回 `--limit` 条（默认 100）。
5. WHEN 查询到事件，THE CLI SHALL 将结果以 NDJSON 格式输出到 stdout，每行一个事件对象。
6. WHEN 无新事件匹配，THE CLI SHALL 输出空内容（无任何行）并以退出码 0 退出。
7. WHEN consumer 的 filter 为 null，THE CLI SHALL 返回所有 `id > <last-event-id>` 的事件（不施加额外过滤）。
8. WHEN 用户提供 `--last-event-id 0`，THE CLI SHALL 从 id 为 1 的事件开始返回（即从头消费）。

---

### 需求 4：事件分发（thread dispatch）

**用户故事**：作为系统内部调度器，我希望 `thread dispatch` 能检查所有订阅并为有未消费事件的 Consumer 启动 handler，以便实现异步事件处理。

#### 验收标准

1. WHEN 执行 `thread dispatch --thread <path>`，THE CLI SHALL 遍历 `subscriptions` 表中所有订阅。
2. WHEN 遍历订阅时，THE CLI SHALL 对每个 consumer 查询是否存在 `id > last_acked_id` 且符合 filter 条件的未消费事件。
3. WHEN consumer 无未消费事件，THE CLI SHALL 跳过该 consumer，不启动 handler。
4. WHEN consumer 有未消费事件，THE CLI SHALL 尝试对 `run/<consumer_id>.lock` 加互斥锁。
5. WHEN 加锁成功，THE CLI SHALL 以 `shell: true` 分离模式 spawn `handler_cmd`，并记录调度详情到日志。
6. WHEN 加锁失败（consumer 正在运行），THE CLI SHALL 跳过该 consumer 并记录跳过原因到日志。
7. WHEN dispatch 完成，THE CLI SHALL 以退出码 0 退出。

---

### 需求 5：订阅管理（thread subscribe / unsubscribe）

**用户故事**：作为系统管理员，我希望能够注册和注销 Consumer 订阅，以便控制哪些 Consumer 接收哪些事件。

#### 验收标准

1. WHEN 用户执行 `thread subscribe --thread <path> --consumer <id> --handler <cmd>`，THE CLI SHALL 将订阅记录插入 `subscriptions` 表，退出码为 0。
2. WHEN 用户执行 `thread subscribe` 且提供 `--filter <sql-where>`，THE CLI SHALL 将 filter 存储到订阅记录中。
3. WHEN 用户执行 `thread subscribe` 且未提供 `--filter`，THE CLI SHALL 将 filter 存储为 null（订阅全部事件）。
4. WHEN `consumer_id` 已存在于 `subscriptions` 表，THE CLI SHALL 输出错误信息（提示先执行 `thread unsubscribe`）到 stderr 并以退出码 1 退出。
5. WHEN 用户执行 `thread unsubscribe --thread <path> --consumer <id>`，THE CLI SHALL 从 `subscriptions` 表删除对应记录，退出码为 0。
6. WHEN 执行 `thread unsubscribe` 且 consumer 不存在，THE CLI SHALL 输出错误信息到 stderr 并以退出码 1 退出。

---

### 需求 6：状态查询（thread info）

**用户故事**：作为运维人员，我希望通过 `thread info` 查看 thread 的当前状态，以便监控事件积压和消费进度。

#### 验收标准

1. WHEN 用户执行 `thread info --thread <path>`，THE CLI SHALL 输出事件总数、订阅列表（含 consumer_id、handler_cmd、filter）、各 consumer 的 `last_acked_id` 和 `updated_at`。
2. WHEN 用户执行 `thread info --thread <path> --json`，THE CLI SHALL 以 JSON 格式输出相同信息到 stdout。
3. WHEN thread 目录不是有效 thread 目录，THE CLI SHALL 输出错误信息到 stderr 并以退出码 1 退出。

---

### 需求 7：错误处理与退出码

**用户故事**：作为调用方，我希望 CLI 工具返回标准化的退出码和错误信息，以便在脚本中可靠地判断执行结果。

#### 验收标准

1. THE CLI SHALL 在操作成功时以退出码 0 退出。
2. WHEN 发生一般逻辑错误（订阅已存在、目录不是有效 thread 等），THE CLI SHALL 以退出码 1 退出。
3. WHEN 发生参数或语法错误（缺少必需参数、类型非法等），THE CLI SHALL 以退出码 2 退出。
4. WHEN 发生错误，THE CLI SHALL 向 stderr 输出格式为 `Error: <什么错了> - <怎么修>` 的错误信息。
5. WHERE `--json` 模式启用，WHEN 发生错误，THE CLI SHALL 向 stderr 输出格式为 `{"error": "...", "suggestion": "..."}` 的 JSON 错误信息。

---

### 需求 8：日志记录

**用户故事**：作为运维人员，我希望 thread 工具将关键操作记录到日志文件，以便排查问题。

#### 验收标准

1. THE CLI SHALL 将运行日志写入 `<thread-dir>/logs/thread.log`，格式为 `[ISO8601] [LEVEL] message`。
2. WHEN push 成功，THE CLI SHALL 记录包含 source、type、event id 的 INFO 日志。
3. WHEN dispatch 成功启动 handler，THE CLI SHALL 记录包含 consumer_id 和 handler_cmd 的 INFO 日志。
4. WHEN dispatch 因锁被占用跳过 consumer，THE CLI SHALL 记录包含 consumer_id 和跳过原因的 INFO 日志。
5. WHEN `thread.log` 超过 10000 行，THE CLI SHALL 将旧文件重命名为 `thread-<YYYYMMDD-HHmmss>.log` 并创建新的空日志文件继续写入。

---

### 需求 9：数据完整性与幂等性

**用户故事**：作为系统架构师，我希望 thread 工具保证数据写入的原子性和调度的幂等性，以便在异常情况下保持数据一致性。

#### 验收标准

1. THE DB SHALL 在所有写操作（push、subscribe、unsubscribe、pop 进度更新）中使用事务，确保原子性。
2. WHEN `--batch` 模式 push，THE DB SHALL 在单个事务中完成所有事件的插入。
3. WHEN notifier 以相同 task-id 被多次调用，THE Notifier SHALL 仅执行一次 dispatch（幂等调度）。
4. WHEN 同一 consumer 的 handler 正在运行，THE CLI SHALL 通过文件锁防止重复启动。
5. THE DB SHALL 开启 WAL 模式以支持并发读写。

---

### 需求 10：thread_path_slug 生成规则

**用户故事**：作为系统内部组件，我希望 thread 路径能被规范化为合法的 notifier task-id，以便唯一标识 dispatch 任务。

#### 验收标准

1. WHEN 生成 `thread_path_slug`，THE CLI SHALL 将 thread 路径中所有非字母数字字符替换为连字符（`-`）。
2. WHEN 生成的 slug 超过 40 个字符，THE CLI SHALL 取前 32 个字符，加 `-`，再加路径 SHA1 的前 6 位，生成最终 slug。
3. WHEN 生成的 slug 不超过 40 个字符，THE CLI SHALL 直接使用替换后的结果作为 slug。
