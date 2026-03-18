# 实现计划：thread-core

## 概述

按照设计文档，将 thread CLI 工具分步实现。每个任务构建在前一个任务的基础上，最终将所有组件串联为完整的可运行 CLI。

## 任务

- [x] 1. 项目初始化与基础配置
  - 创建 `package.json`（ESM、bin 字段指向 `dist/index.js`、依赖：`commander`、`better-sqlite3`、`@types/better-sqlite3`、`fast-check`、`vitest`、`tsup`、`@types/node`，版本对齐 notifier/xdb repo）
  - 创建 `tsconfig.json`（与 pai/notifier repo 完全一致：`module: nodenext`、`target: esnext`、`strict: true`、`noUncheckedIndexedAccess: true` 等）
  - 创建 `tsup.config.ts`（与 pai/notifier repo 完全一致：ESM、shebang banner、`entry: ['src/index.ts']`、`external: ['canvas', 'jsdom']`）
  - 创建 `vitest.config.ts`（与 pai/notifier repo 完全一致：`fileParallelism: false`、`testTimeout: 10000`、`watch: false`）
  - 创建 `src/types.ts`，定义 `Event`、`Subscription`、`ConsumerProgress`、`PushPayload`、`ThreadInfo` 接口
  - 创建 `src/os-utils.ts`，直接从 pai repo 拷贝，不做任何修改
  - _需求：2（技术栈）_

- [x] 2. 数据库层实现
  - [x] 2.1 实现 `src/db/init.ts`
    - `openDb(threadDir)` 打开 `events.db`，开启 WAL 模式
    - `initSchema(db)` 创建三张表及索引（使用 `CREATE TABLE IF NOT EXISTS`）
    - _需求：1.4、1.5、9.5_
  - [x] 2.2 实现 `src/db/queries.ts`
    - `insertEvent`、`insertEventsBatch`（事务）
    - `getSubscriptions`、`getSubscription`、`insertSubscription`、`deleteSubscription`
    - `getConsumerProgress`、`upsertConsumerProgress`
    - `popEvents`（带 filter 动态拼接）、`hasUnconsumedEvents`
    - `getEventCount`、`getThreadInfo`
    - _需求：2.1、2.7、3.1、3.4、4.2、5.1、5.5、6.1_
  - [x]* 2.3 为 db 层编写单元测试（`vitest/unit/db-init.test.ts`、`vitest/unit/db-queries.test.ts`）
    - 测试 schema 创建、WAL 模式、重复初始化检测
    - 测试各 SQL 操作的正确性和边界值（id=0、空结果集、null filter）
    - _需求：1.4、3.7、3.8_

- [x] 3. 支撑模块实现
  - [x] 3.1 实现 `src/event-log.ts`
    - `appendEventLog`、`appendEventsBatch`：追加事件到 JSONL
    - `rotateIfNeeded`：检查行数，超过 10000 时重命名旧文件并创建新文件
    - _需求：2.1、2.10_
  - [x] 3.2 实现 `src/notifier-client.ts`
    - `buildTaskId(threadDir)`：生成 `thread_path_slug`（替换非字母数字为 `-`，超长时截断+SHA1 前缀）
    - `scheduleDispatch(threadDir, source)`：使用 `execCommand`（from os-utils.ts）调用 notifier CLI，退出码 0/1 均视为成功，其他退出码记录警告日志但不影响 push 退出码
    - _需求：2.5、2.6、10.1、10.2、10.3_
  - [x] 3.3 实现 `src/logger.ts`
    - 参考 notifier repo 的 `src/logger.ts` 实现（`createFileLogger` / `createStderrLogger` 模式）
    - `createFileLogger(threadDir)`：写入 `<threadDir>/logs/thread.log`，初始化时检查行数，超过 10000 行时轮换为 `thread-<YYYYMMDD-HHmmss>.log`
    - `createStderrLogger()`：写入 stderr，用于无 threadDir 时的错误输出
    - _需求：8.1、8.5_
  - [x] 3.4 实现 `src/help.ts`
    - 参考 notifier/pai repo 的 help.ts 模式
    - 定义 `MAIN_EXAMPLES`（各子命令用法示例）和 `MAIN_VERBOSE`（退出码说明）
    - 导出 `installHelp(program: Command): void`，支持 `--verbose` 与 `--help` 联用
    - _需求：7（退出码文档）_
  - [x]* 3.5 为支撑模块编写单元测试
    - `vitest/unit/event-log.test.ts`：追加、轮换触发条件
    - `vitest/unit/notifier-client.test.ts`：slug 生成算法（各种路径格式、超长路径）
    - `vitest/unit/logger.test.ts`：日志格式、轮换逻辑
    - _需求：8.1、10.1、10.2、10.3_
  - [x]* 3.6 为 slug 生成编写属性测试（`vitest/pbt/slug.pbt.ts`）
    - **属性 7：thread_path_slug 长度约束**
    - 对任意路径字符串，生成的 slug 长度 ≤ 40 且仅含字母数字和连字符
    - `// Feature: thread-core, Property 7: thread_path_slug 长度约束`
    - _需求：10.1、10.2、10.3_

- [x] 4. 实现 `thread init` 命令（`src/commands/init.ts`）
  - 创建目录结构（`run/`、`logs/`）
  - 调用 `openDb` + `initSchema`
  - 创建空 `events.jsonl`
  - 检测已存在有效 thread 目录时报错退出（退出码 1）
  - _需求：1.1、1.2、1.3、1.4、1.5_
  - [x]* 4.1 为 init 命令编写单元测试（`vitest/unit/commands/init.test.ts`）
    - 测试新目录初始化、已存在非 thread 目录初始化、已存在 thread 目录报错
    - _需求：1.1、1.2、1.3_

- [x] 5. 实现 `thread push` 命令（`src/commands/push.ts`）
  - 单条模式：验证参数，调用 `insertEvent`，追加 JSONL，调用 `scheduleDispatch`
  - `--batch` 模式：从 stdin 读 NDJSON，调用 `insertEventsBatch`，追加 JSONL，触发一次 dispatch
  - 检查 JSONL 行数并在必要时轮换
  - 记录 push 成功日志
  - _需求：2.1、2.2、2.3、2.4、2.5、2.6、2.7、2.8、2.9、2.10_
  - [x]* 5.1 为 push 命令编写单元测试（`vitest/unit/commands/push.test.ts`）
    - 测试单条 push、batch push、notifier 退出码 1 处理、无效 thread 目录报错
    - _需求：2.1、2.6、2.9_
  - [x]* 5.2 为 push-pop 编写属性测试（`vitest/pbt/push-pop.pbt.ts`）
    - **属性 1：push 后事件可查询（Round Trip）**
    - 对任意合法 PushPayload，push 后 pop 应能取回字段完全一致的事件
    - `// Feature: thread-core, Property 1: push 后事件可查询`
    - _需求：2.1、2.2、2.3、2.4_
  - [x]* 5.3 为 batch push 编写属性测试（`vitest/pbt/batch-push.pbt.ts`）
    - **属性 2：batch push 原子性**
    - 对任意 N 条 payload 的 batch，push 后事件总数恰好增加 N；模拟失败时全部回滚
    - `// Feature: thread-core, Property 2: batch push 原子性`
    - _需求：2.7、9.2_

- [x] 6. 检查点 —— 确保所有测试通过，如有问题请告知。

- [-] 7. 实现 `thread subscribe` 和 `thread unsubscribe` 命令
  - [x] 7.1 实现 `src/commands/subscribe.ts`
    - 验证 consumer_id 不重复，调用 `insertSubscription`
    - consumer_id 已存在时报错退出（退出码 1，提示先 unsubscribe）
    - _需求：5.1、5.2、5.3、5.4_
  - [x] 7.2 实现 `src/commands/unsubscribe.ts`
    - 验证 consumer 存在，调用 `deleteSubscription`
    - 不存在时报错退出（退出码 1）
    - _需求：5.5、5.6_
  - [ ] 7.3 为 subscribe/unsubscribe 编写单元测试（`vitest/unit/commands/subscribe.test.ts`）

    - 测试正常订阅、重复订阅报错、正常注销、注销不存在的 consumer 报错
    - _需求：5.1、5.4、5.5、5.6_
  - [x]* 7.4 为 subscribe/unsubscribe 编写属性测试（`vitest/pbt/subscribe.pbt.ts`）
    - **属性 5：subscribe 后可查询（Round Trip）**
    - **属性 6：unsubscribe 后不可查询（Round Trip）**
    - 对任意合法 Subscription，subscribe 后 getSubscription 应返回相同记录；unsubscribe 后返回 null
    - `// Feature: thread-core, Property 5: subscribe round trip`
    - `// Feature: thread-core, Property 6: unsubscribe round trip`
    - _需求：5.1、5.5_

- [x] 8. 实现 `thread pop` 命令（`src/commands/pop.ts`）
  - 查询 consumer 的 filter（consumer 不存在则报错退出）
  - upsert consumer_progress
  - 执行带 filter 的事件查询
  - 输出 NDJSON 到 stdout
  - _需求：3.1、3.2、3.3、3.4、3.5、3.6、3.7、3.8_
  - [x]* 8.1 为 pop 命令编写单元测试（`vitest/unit/commands/pop.test.ts`）
    - 测试正常消费、空结果、consumer 不存在报错、filter 过滤、last-event-id=0 从头消费
    - _需求：3.2、3.6、3.7、3.8_
  - [x]* 8.2 为 pop filter 编写属性测试（`vitest/pbt/pop-filter.pbt.ts`）
    - **属性 3：pop 过滤正确性**
    - 对任意 consumer（含非空 filter）和 last-event-id，pop 返回的事件均满足 id > last-event-id 且符合 filter
    - `// Feature: thread-core, Property 3: pop 过滤正确性`
    - **属性 4：pop 进度更新幂等性**
    - 以相同 last-event-id 连续两次 pop，consumer_progress 中的值不变，返回事件集相同
    - `// Feature: thread-core, Property 4: pop 幂等性`
    - _需求：3.3、3.4、3.7_

- [x] 9. 实现 `thread dispatch` 命令（`src/commands/dispatch.ts`）
  - 遍历所有订阅，查询各 consumer 的未消费事件
  - 尝试文件锁（`run/<consumer_id>.lock`），加锁成功则 spawn handler_cmd（shell: true，分离模式）
  - 加锁失败则跳过并记录日志
  - 记录调度详情到日志
  - _需求：4.1、4.2、4.3、4.4、4.5、4.6、4.7_
  - [x]* 9.1 为 dispatch 命令编写单元测试（`vitest/unit/commands/dispatch.test.ts`）
    - 测试无订阅时正常退出、有未消费事件时 spawn handler、锁已持有时跳过
    - _需求：4.3、4.5、4.6_

- [x] 10. 实现 `thread info` 命令（`src/commands/info.ts`）
  - 调用 `getThreadInfo` 获取事件总数、订阅列表、消费进度
  - 默认文本输出，`--json` 时输出 JSON
  - _需求：6.1、6.2、6.3_
  - [x]* 10.1 为 info 命令编写单元测试（`vitest/unit/commands/info.test.ts`）
    - 测试文本输出格式、JSON 输出格式、无效 thread 目录报错
    - _需求：6.1、6.2、6.3_

- [x] 11. 实现 `src/index.ts` 入口，串联所有子命令
  - 参考 pai repo 的 `src/index.ts` 模式
  - 创建 commander program，从 package.json 读取版本号
  - 调用 `installHelp(program)`
  - `program.exitOverride()` + try/catch，commander 退出码 1 映射为 2
  - EPIPE 错误处理（`process.stdout.on('error', ...)`）
  - 注册所有子命令（init、push、pop、dispatch、subscribe、unsubscribe、info）
  - 未知命令以退出码 2 退出
  - _需求：7.2、7.3_

- [ ] 12. 检查点 —— 确保所有测试通过，如有问题请告知。

## 备注

- 标有 `*` 的子任务为可选任务，可跳过以优先完成核心功能
- 每个任务均引用具体需求编号以便追溯
- 检查点确保增量验证，尽早发现问题
- 属性测试验证普遍性正确性，单元测试验证具体示例和边界条件
