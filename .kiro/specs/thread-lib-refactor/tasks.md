# 实施计划：thread CLI/LIB 双接口改造

## 概述

将 thread 改造为 CLI/LIB 双接口模块。按照"先建 lib 层，再接入 CLI，最后更新构建配置"的顺序推进，确保每一步都有可验证的产出。

## 任务

- [ ] 1. 新建 `src/lib/types.ts`，定义 lib 层共享类型
  - 定义 `ThreadEventInput` 接口（`source`、`type: 'message' | 'record'`、`subtype?: string`、`content: string`）
  - 定义 `ThreadEvent` 接口（继承 `ThreadEventInput`，新增 `id: number`、`created_at: string`，`subtype: string | null`）
  - 定义 `PeekOptions` 接口（`lastEventId: number`、`limit?: number`、`filter?: string`）
  - 定义 `ThreadErrorCode` 联合类型（`'THREAD_ALREADY_EXISTS' | 'THREAD_NOT_INITIALIZED' | 'THREAD_CLOSED'`）
  - 定义 `ThreadError` 类（继承 `Error`，携带 `code: ThreadErrorCode`，设置 `this.name = 'ThreadError'`）
  - _Requirements: 需求 1-9_

- [ ] 2. 新建 `src/lib/db.ts`，提取 SQLite 操作到 lib 层
  - [ ] 2.1 将 `src/db/init.ts` 的 `openDb()` 和 `initSchema()` 复制到 `src/lib/db.ts`（保留原文件供 CLI 其他命令使用）
  - [ ] 2.2 将 `insertEvent()`、`insertEventsBatch()` 从 `src/db/queries.ts` 复制到 `src/lib/db.ts`，参数类型改为 `ThreadEventInput`（来自 `src/lib/types.ts`）
  - [ ] 2.3 新增 `peekEvents()` 函数（逻辑与现有 `popEvents()` 相同，返回类型改为 `ThreadEvent[]`）
  - _Requirements: 需求 5.1, 6.1, 7.1-7.4_

- [ ] 3. 新建 `src/lib/event-log.ts`，迁移 JSONL 追加写入逻辑
  - 将 `src/event-log.ts` 内容复制到 `src/lib/event-log.ts`，类型引用改为 `ThreadEvent`（来自 `src/lib/types.ts`）
  - 保留原 `src/event-log.ts`（供 CLI 其他命令使用，直到全部迁移完成）
  - _Requirements: 需求 5.1, 6.1_

- [ ] 4. 新建 `src/lib/thread-store.ts`，实现 `ThreadStore` 类
  - [ ] 4.1 实现 `ThreadStore` 类骨架：`readonly threadPath`、私有 `db`、私有 `closed` 标志、构造函数
  - [ ] 4.2 实现 `push(event: ThreadEventInput): Promise<ThreadEvent>`
    - 检查 `closed`，若已关闭则 throw `new ThreadError('ThreadStore is closed', 'THREAD_CLOSED')`
    - 调用 `insertEvent(db, event)` 获取 `id`
    - 构造 `ThreadEvent`（`created_at: new Date().toISOString()`，`subtype: event.subtype ?? null`）
    - 调用 `appendEventLog(threadPath, threadEvent)`
    - 返回 `ThreadEvent`
    - _Requirements: 需求 5.1, 5.2, 5.3, 5.4_
  - [ ] 4.3 实现 `pushBatch(events: ThreadEventInput[]): Promise<ThreadEvent[]>`
    - 检查 `closed`
    - 空数组直接返回 `[]`
    - 调用 `insertEventsBatch(db, events)` 获取 `ids[]`
    - 构造 `ThreadEvent[]`，调用 `appendEventsBatch()`
    - 返回 `ThreadEvent[]`
    - _Requirements: 需求 6.1, 6.2, 6.3_
  - [ ] 4.4 实现 `peek(opts: PeekOptions): Promise<ThreadEvent[]>`
    - 检查 `closed`
    - 调用 `peekEvents(db, opts.lastEventId, opts.filter ?? null, opts.limit ?? 100)`
    - 返回结果（不修改数据库）
    - _Requirements: 需求 7.1-7.5_
  - [ ] 4.5 实现 `close(): void`
    - 若已 `closed`，直接返回（幂等）
    - 调用 `db.close()`，设置 `closed = true`
    - _Requirements: 需求 8.1, 8.2_
  - [ ]* 4.6 编写 `ThreadStore` 单元测试（`vitest/unit/thread-store.test.ts`）
    - 测试 `push()` 写入并可通过 `peek()` 读回
    - 测试 `pushBatch()` 空数组返回 `[]`
    - 测试 `close()` 后调用 `push()` 抛出 `ThreadError(THREAD_CLOSED)`
    - _Requirements: 需求 5.1, 6.2, 8.2_

- [ ] 5. 新建 `src/lib/thread-lib.ts`，实现 `ThreadLib` 类
  - [ ] 5.1 实现私有 `_initDir(threadPath: string): void`
    - `mkdirSync(path.join(threadPath, 'run'), { recursive: true })`
    - `mkdirSync(path.join(threadPath, 'logs'), { recursive: true })`
    - `openDb(threadPath)` → `initSchema(db)` → `db.close()`
    - 若 `events.jsonl` 不存在则创建空文件
  - [ ] 5.2 实现 `open(threadPath: string): Promise<ThreadStore>`
    - 检查 `events.db` 是否存在（`existsSync(path.join(threadPath, 'events.db'))`）
    - 若不存在：调用 `_initDir(threadPath)`
    - 调用 `openDb(threadPath)`，返回 `new ThreadStore(threadPath, db)`
    - _Requirements: 需求 1.1, 1.2, 1.3, 1.4_
  - [ ] 5.3 实现 `init(threadPath: string): Promise<ThreadStore>`
    - 检查 `events.db` 是否存在
    - 若已存在：throw `new ThreadError('Thread already exists at ...', 'THREAD_ALREADY_EXISTS')`
    - 调用 `_initDir(threadPath)`，返回 `new ThreadStore(threadPath, openDb(threadPath))`
    - _Requirements: 需求 2.1, 2.2, 2.3_
  - [ ] 5.4 实现 `exists(threadPath: string): Promise<boolean>`
    - 返回 `existsSync(path.join(threadPath, 'events.db'))`
    - _Requirements: 需求 3.1, 3.2, 3.3_
  - [ ] 5.5 实现 `destroy(threadPath: string): Promise<void>`
    - 若目录不存在：直接返回（幂等）
    - 调用 `fs.rm(threadPath, { recursive: true, force: true })`
    - _Requirements: 需求 4.1, 4.2, 4.3_
  - [ ]* 5.6 编写 `ThreadLib` 单元测试（`vitest/unit/thread-lib.test.ts`）
    - 测试 `open()` 对不存在路径自动初始化
    - 测试 `open()` 对已存在路径不破坏数据
    - 测试 `init()` 对已存在 thread 抛出 `THREAD_ALREADY_EXISTS`
    - 测试 `exists()` 在 init 前后的返回值
    - 测试 `destroy()` 删除目录后 `exists()` 返回 false
    - 测试 `destroy()` 对不存在路径不抛出错误
    - _Requirements: 需求 1-4_

- [ ] 6. 新建 `src/index.ts`（LIB 入口）
  - export `ThreadLib` from `'./lib/thread-lib.js'`
  - export `ThreadStore` from `'./lib/thread-store.js'`
  - export type `ThreadEvent`, `ThreadEventInput`, `PeekOptions` from `'./lib/types.js'`
  - export `ThreadError` from `'./lib/types.js'`
  - 文件中不包含任何顶层副作用代码（无 `process.on`、无 `new Database()`、无文件读写）
  - _Requirements: 需求 9.1_

- [ ] 7. 检查点 — 确保所有测试通过，TypeScript 编译无错误
  - 运行 `npm test`，确保所有测试通过
  - 运行 `npx tsc --noEmit 2>&1`，确保无类型错误
  - 如有问题，在此处修复后再继续

- [ ] 8. 将现有 `src/index.ts` 重命名为 `src/cli.ts`
  - 将 `src/index.ts` 内容复制到 `src/cli.ts`（内容完全不变）
  - 删除原 `src/index.ts`（此时 `src/index.ts` 已是步骤 6 创建的 LIB 入口）
  - 验证 `src/cli.ts` 中所有 import 路径仍然正确（`.js` 后缀）
  - _Requirements: 需求 10.5_

- [ ] 9. 更新 `src/commands/init.ts`，改为调用 `ThreadLib.init()`
  - 移除直接的 `mkdirSync`、`openDb`、`initSchema`、`writeFileSync` 调用
  - import `ThreadLib` from `'../lib/thread-lib.js'`，import `ThreadError` from `'../lib/types.js'`
  - 实例化 `new ThreadLib()`，调用 `lib.init(resolved)`
  - catch `ThreadError(THREAD_ALREADY_EXISTS)`，输出原有错误信息并 exit 1
  - 成功后调用 `store.close()`，输出 `Initialized thread at ${resolved}\n`
  - _Requirements: 需求 10.3_

- [ ] 10. 更新 `src/commands/push.ts`，改为调用 `ThreadStore.push()` / `pushBatch()`
  - 移除直接的 `insertEvent`、`insertEventsBatch`、`appendEventLog`、`appendEventsBatch`、`rotateIfNeeded` 调用
  - import `ThreadLib` from `'../lib/thread-lib.js'`
  - 实例化 `new ThreadLib()`，调用 `lib.open(threadDir)` 获取 `store`
  - 单条模式：调用 `store.push(payload)`，保留 `scheduleDispatch()` 调用（CLI 特有）
  - 批量模式：调用 `store.pushBatch(payloads)`，保留 `scheduleDispatch()` 调用
  - `finally` 块中调用 `store.close()`
  - 保留现有的参数验证逻辑和错误处理
  - _Requirements: 需求 10.1, 10.2_

- [ ] 11. 更新 `src/commands/peek.ts`，改为调用 `ThreadStore.peek()`
  - 移除直接的 `openDb`、`popEvents` 调用
  - import `ThreadLib` from `'../lib/thread-lib.js'`
  - 实例化 `new ThreadLib()`，调用 `lib.open(threadDir)` 获取 `store`
  - 调用 `store.peek({ lastEventId, limit, filter: options.filter })`
  - `finally` 块中调用 `store.close()`
  - 保留现有的参数验证逻辑和 NDJSON 输出格式
  - _Requirements: 需求 10.4_

- [ ] 12. 检查点 — 验证 CLI 兼容性
  - 运行 `npm test`，确保所有测试通过
  - 运行 `npx tsc --noEmit 2>&1`，确保无类型错误
  - 手动验证 `thread init`、`thread push`、`thread peek` 命令行为与 v1 一致

- [ ] 13. 更新 `tsup.config.ts` 为双 entry 构建
  - 将单 entry 配置改为数组形式（两个配置对象）
  - 第一个配置：`entry: ['src/index.ts']`，`dts: true`，无 `banner`，`clean: true`
  - 第二个配置：`entry: ['src/cli.ts']`，`dts: false`，`banner: { js: '#!/usr/bin/env node' }`，无 `clean`
  - 两个配置均：`format: ['esm']`，`target: 'node22'`，`sourcemap: true`
  - _Requirements: 需求 11.1, 11.2, 11.3_

- [ ] 14. 更新 `package.json`
  - 新增 `"exports": { ".": "./dist/index.js" }` 字段
  - 新增 `"main": "./dist/index.js"` 字段
  - 新增 `"types": "./dist/index.d.ts"` 字段
  - 将 `"bin": { "thread": "dist/index.js" }` 改为 `"bin": { "thread": "./dist/cli.js" }`
  - 将 `"test"` script 改为 `"vitest run"`（去掉现有的 `test:run` 别名，统一为 `test`）
  - _Requirements: 需求 12.1-12.4_

- [ ] 15. 运行构建，验证双 entry 产物
  - 运行 `npm run build`
  - 验证 `dist/index.js` 存在且不含 shebang
  - 验证 `dist/index.d.ts` 存在
  - 验证 `dist/cli.js` 存在且第一行为 `#!/usr/bin/env node`
  - 验证 `dist/cli.d.ts` 不存在
  - _Requirements: 需求 11.1, 11.2_

- [ ] 16. 编写属性测试（`vitest/pbt/`）
  - [ ]* 16.1 编写 `vitest/pbt/thread-lib.pbt.test.ts`
    - **Property 1：open() 自动初始化** — 对随机临时路径调用 open()，验证 events.db 存在且 ThreadStore 可用
    - **Property 2：open() 幂等性** — 对已初始化 thread 多次调用 open()，验证数据不变
    - **Property 3：init() 严格新建** — 对已初始化 thread 调用 init()，验证抛出 THREAD_ALREADY_EXISTS 且数据不变
    - **Property 4：exists() 正确反映 thread 状态** — init 后 exists() = true，destroy 后 exists() = false
    - **Property 5：destroy() round-trip** — destroy 后 exists() = false，对不存在路径 destroy() 不抛错
    - 每个属性测试 `numRuns: 100`，使用独立临时目录，finally 块清理
    - _Requirements: 需求 1-4_
  - [ ]* 16.2 编写 `vitest/pbt/thread-store.pbt.test.ts`
    - **Property 6：push() round-trip** — 随机 ThreadEventInput，push 后 peek(0) 可读回，字段一致，subtype 为 null 时正确
    - **Property 7：push() id 严格递增** — 多次 push，验证 id 严格单调递增
    - **Property 8：pushBatch() round-trip** — 随机事件数组，pushBatch 后 peek 可读回所有事件，顺序一致；空数组返回 []
    - **Property 9：peek() 过滤正确性** — 随机 lastEventId N，peek(N) 返回的所有事件 id > N，按升序排列
    - **Property 10：peek() limit 约束** — 超过 L 条事件时，peek({ limit: L }) 返回数量 ≤ L
    - **Property 11：peek() 幂等性** — 多次 peek() 不写入时返回相同结果
    - **Property 12：close() 后操作抛出错误** — close 后调用 push/peek 抛出错误
    - **Property 13：lib 错误不调用 process.exit()** — 触发各种错误条件，验证 throw 而非 exit
    - 每个属性测试 `numRuns: 100`，使用独立临时目录，finally 块清理
    - _Requirements: 需求 5-9_

- [ ] 17. 最终检查点 — 确保所有测试通过，构建产物正确
  - 运行 `npm test`，确保所有测试通过
  - 运行 `npx tsc --noEmit 2>&1`，确保无类型错误
  - 运行 `npm run build`，确保构建成功
  - 如有问题，在此处修复后完成

## 备注

- 标有 `*` 的子任务为可选测试任务，可跳过以优先完成核心实现
- `src/db/` 目录保留不删除，供 `pop`、`dispatch`、`subscribe`、`unsubscribe`、`info` 命令继续使用
- 原 `src/event-log.ts` 保留不删除，待所有命令迁移完成后可统一清理（超出本次改造范围）
- 所有本地 import 必须带 `.js` 后缀（ESM + NodeNext 要求）
- 每个任务引用设计文档中的具体接口定义，实现时以 `design.md` 为准
