# 02 关联编号与请求／失效广播接入

Triage: ready-for-agent
State: resolved
Blocked by: 无（01 已 resolved）

## 内容
- `traceId`：渲染进程生成，经 IPC、HTTP 请求头传到后端；同步修改现有请求校验白名单与测试，仍拒绝未知字段。
- 接入点：`desktop/src/main/contacts/session.ts` 的 `scopeRevision` 变化（附 from／to 与原因枚举）；`desktop/src/main/memory/sqlite-management.ts` 的 `synchronize`／`release` 调用者；`desktop/src/main/data-lifecycle.ts` 撤下；`desktop/src/main/index.ts` 的范围变化回调；前台控制器 `beginReadingScopeChange`；`requestJson` 的耗时、超时、中止；后端慢 SQL 指纹聚合。
- 到位后复现"记忆页读取后弹出资料资格或连接已变化"，用日志指出触发源。

## 完成条件
- 一次真实操作可凭 `traceId` 还原跨进程时间线；`## Answer` 写明触发源结论、验证命令与结果。

## Comments

## Answer

实现与隔离验证已完成，本地提交 `abd76bbf5`；State 暂保留 claimed，等待主 Agent 的真实开发 App 读取时间线与最终两轴审查。

- renderer 的管理读取、历史、主题与决定在 preload 生成随机 UUID，经严格 IPC 白名单、主进程、`X-Trace-Id`、后端 HTTP 的 AsyncLocalStorage、主写者／附属只读 Worker 包络传递。未知 IPC 字段、非 UUID trace、未知查询字段仍拒绝；trace 不进入业务请求正文或查询条件。
- 范围变化记录 from/to、固定 caller 与原因；管理 synchronize/release/invalidated 记录触发 trace 与 interruptedTraceId。覆盖联系人选择、目录移除／失败、连接换代、前台读取范围 begin/end、资料生命周期撤下、读失败与退出。请求记录开始／结束／耗时，1 秒慢请求、超时与取消只使用固定原因。
- SQL 参数从不传入日志聚合器，仅模板 SHA256、调用计数、耗时；同一动作最多 128 个模板。Worker 不初始化日志写者，事件与 SQL 汇总随回包交宿主唯一 writer。`recordUnifiedDiagnostic?` 在事务内仅缓冲已核验事件（最多 128 条），提交后发布，回滚／busy 重试丢弃，非法诊断不影响业务回执。
- 为兼容既有 ESM 验证入口，抽出无静态 pino 依赖的 `diagnostics/context.ts`；`unified.ts` 保持原 API 并同步注册同实例。后台只有存在已授权诊断根时才异步初始化，有界暂存 128 条；无根不打开文件。保留 `2068bb54b` 的超时独立错误修复，没有改写原管理页三处 WIP、05 批量核验、图片或外部会话文件。

### 失效触发源与证据边界

- 历史触发链为 **请求运输超时 → 旧版 management read 的 catch 无条件调用 synchronize → 广播 memory:management-invalidated → 页面撤下资料**。原版本为 `baae193625d43d7315f04c989d3685922f1f4fec`；另一会话修复 `2068bb54b` 已使连接失败／超时不再自动广播资料失效。
- 新测试只在隔离 esbuild 入口加载上述旧 controller，通过其公开 backend/publish 端口连接新 logger。为有界验收，将测试运输期限从产品 10 秒缩至 20 毫秒；实际本机 HTTP 超时日志依次为 `request.started`、`request.failed(reasonCode=request_timeout)`、`management.invalidated(caller=management_read_failed, reasonCode=request_timeout)`。最后一条由隔离的旧发布端口适配记录；它证明旧控制流，不能冒称旧代码原本自带日志，也不是当前真实 App 故障再现。
- 当前控制器测试已验证同类超时保留原有资料／编辑，不广播失效；真实范围或连接同时变化仍撤下。真实开发 App 的目标联系人读取由主 Agent 统一补验，不回退真实 App 源码、不改变业务数据制造故障。

### 命令与真实结果

1. `cd backend-ts && node --test test/unified-trace-storage.test.mjs`：2/2；真实 SQLite 合成库验证 commit/rollback/busy 重试与两种 Worker 的 101 次 SQL 各汇总一条，不含 SQL 原文。
2. `cd backend-ts && pnpm run typecheck && node --test test/unified-trace-storage.test.mjs test/sqlite-readonly.test.mjs test/sqlite-storage-timing.test.mjs test/sqlite-storage.test.mjs`：typecheck 退出 0，32/32；约 69 秒，包含既有 15 秒动作预算／维护长动作。完整端侧日志 `/tmp/notalone-02-backend-tests.log`。
3. `cd desktop && pnpm run typecheck && node --test tests/unified-trace.test.mjs tests/sqlite-memory-read-failure.test.mjs tests/data-lifecycle.test.mjs tests/contact-session-deletion.test.mjs tests/foreground-confirmation-binding.test.mjs tests/manual-foreground-resume.test.mjs tests/foreground-latency.test.mjs`：typecheck 退出 0，执行时 69/69（当时 trace 文件为 4 例）；日志 `/tmp/notalone-02-desktop-tests.log`。含真实 Chrome 合成页面的超时保持正文、依据与编辑用例；此项不是实际 Electron 验收。
4. `cd desktop && node --test tests/unified-trace.test.mjs`：新增第 5 例后 5/5。真实双进程合成时间线样例 `a350b18e-78b0-4443-adf0-c9e9735ff622`，main/backend 共 16 条，包含管理与主题请求及 Worker SQL 汇总；测试内实际执行 `pnpm run diag --data-dir <隔离目录> --trace <编号>`，逐项核对条数与时间排序。另验证原生 Node TypeScript 和主进程 CJS 的惰性初始化；日志 `/tmp/notalone-02-trace-tests.log`。
5. `cd desktop && node --test tests/sqlite-memory-management.test.mjs`：21/21。旧 IPC 精确断言先暴露新增 trace，随后只更新该非 WIP 测试，要求新增 trace 是 UUID、其余请求字段完整一致；单例 1/1 后完整通过。日志 `/tmp/notalone-02-management-tests.log`。
6. `cd backend-ts && pnpm run typecheck && node --test test/unified-trace-storage.test.mjs test/unified-diagnostic-contract.test.mjs test/unified-diagnostic-regression.test.mjs`：12/12，含事件字段越界扫描与敏感 canary；日志 `/tmp/notalone-02-contract-tests.log`。静态事件 16 个调用点，9 个动态参数／事件／展开仍由运行时核验，不假称静态全覆盖。
7. `git diff --check` 通过；`node scripts/check_public_history.mjs --ref HEAD --working-tree` 在当时 HEAD `32f75bfda` 检查命中为 0。最终提交后另复验。

数据影响：只新增本机无正文日志和随机关联编号，不新增上传、业务权限或发送能力。以上库与HTTP数据均为合成隔离测试，用后自动删除；没有读取／复制真实库。剩余风险：日志异步队列在异常退出时可能丢失尾部；SQL计时仍有CPU成本，01–04集成后须统一补测最终开关开销；当前真实 App 的跨进程操作及真实失效源结论待主 Agent 记录。

### 主 Agent 亲验后的交审修正

- 亲验发现未知异常的 `code` getter 可能抛错并替换原业务异常。已在分类器容错，失败仅返回固定 `request_failed`，保留原异常对象。公共 `tracedRequest` 合成负测覆盖 `code`／`kind`／`name` 三种抛错 getter；red 阶段身份断言失败，修复后 1/1，通过后完整 trace 文件 6/6。canary 原文和堆栈不进入诊断。
- 精确在 `desktop/tests/inventory.json` 的 safe-node 只登记新增 `unified-trace.test.mjs`，未改其他类别。`pnpm --dir desktop run test:inventory` 通过（safe-node 163 等，仅文件登记）；`pnpm --dir desktop run typecheck` 退出 0。主 Agent 此前亲跑相关清单 70/70（含新增 context 用例）。
- 按主 Agent 指示，以 30 个所属代码／测试文件执行 `git commit --only` 创建 `abd76bbf5`，未夹带用户三处 WIP、03 或外部图片任务文件，无署名 footer、未 push。runtime 再次冻结供固定提交两轴审查及真实桌面验收；本任务记录仍为端侧忽略文件，未强行提交。
- 提交后 `node scripts/check_public_history.mjs --ref HEAD --working-tree`：HEAD `abd76bbf5`，25817 blobs／3492 commits／2013 current files，命中 0；日志 `/tmp/notalone-02-public-history-final.log`。

### 固定提交审查修正与实际 App 证据

- Standards 独立审查未发现新增问题；Spec 发现首次惰性初始化队列在写者就绪后才补时间，可能把 backend started 排到 main finished 后。已由 `context.ts` 在事件发生时保存内部 observedAt，通过受信任内部 writer 回放到 pino；公共事件契约未增加 `time`／`observedAt`。内部 WeakMap 闭包调用私有写入方法，不经 IPC／HTTP 暴露。
- 首次加载因果回归先失败（原生子进程 `withinObservedCall=false`），修复后 Node TypeScript 与主进程 CJS 均通过：最终记录时间精确落在调用 diagnose 的 before/after 窗口内。夹具同时证明首次暂存与已初始化后的公开 diagnose 都拒绝越界时间字段。最小单例 1/1 后，`cd desktop && pnpm run typecheck && node --test tests/unified-trace.test.mjs tests/unified-diagnostic-bridge.test.mjs` 9/9；`cd backend-ts && pnpm run typecheck && node --test test/unified-diagnostic-*.test.mjs` 19/19。日志分别 `/tmp/notalone-02-observed-desktop.log`、`/tmp/notalone-02-observed-backend.log`。
- 精确后续修复提交为 `c448e3ca1`（仅 6 个 02 文件）；runtime 再次冻结，等待原 Spec 审查者复验。State 仍 claimed，复验完成后方改 resolved。
- `c448e3ca1` 提交后完整公开历史与工作树检查退出 0、命中 0（25835 blobs／3494 commits／2015 current files）；日志 `/tmp/notalone-02-observed-public.log`。
- 主 Agent 已实际操作开发 App：目标联系人读取显示 16 条正式记忆与 1 条候选，没有资料失效提示。真实关联编号 `9a3be84a-6c6a-43df-98a1-83b68faa8d43` 具有 main/backend 共 65 条记录，其中 59 条 SQL 汇总合计 5191 次调用；main 请求 470.261 ms、backend 469.217 ms。`pnpm run diag --trace 9a3be84a-6c6a-43df-98a1-83b68faa8d43` 退出 0，可还原实际时间线。此证据证明当前真实读取集成；历史误报仍按上面的隔离旧版证据解释，没有宣称当前 App 重现已修复故障。

### SQL 模块筛选补充

- 主 Agent 发现 `memoryExtraction.*` 与文档处理 SQL 被缺省归入管理模块，按 `--module memory.processing` 会遗漏。按当前真实注册表核对：`memoryExtraction.*` 全部归处理；`memoryDocuments.read` 是正式主题集合页面读取，仍归管理，其余 `memoryDocuments.*` 的任务、调度与发布均归处理；联系人域真实前缀是 `identity.*`，改归 `contacts`。04 的其他模块可逐模块补充，未改业务动作实现。
- 新增默认真实 SQLite registry 集成测试（不用 SQL 替身）：执行 `identity.initialize` 后分别执行提取开关读／写、文档 claimDue、正式主题 read 与联系人 directory，逐操作 trace 核对实际落盘 SQL 汇总模块；另明确断言 start／claim／readTask／readSchedule 的分类。最初失败于 `memoryExtraction.readAutomatic` 的模块归属，修复后最小单例 1/1、完整 `test/unified-trace-storage.test.mjs` 3/3，`pnpm --dir backend-ts run typecheck` 退出 0；日志 `/tmp/notalone-02-sql-modules.log`。
- 精确本地修复提交 `5ead41501` 仅含 `sql-summary.ts` 与该集成测试两文件；runtime 冻结，State 继续 claimed 等主 Agent 统一放行。未重复运行无影响的 32 项存储全量回归。
- 提交后完整公开历史与工作树检查退出 0、命中 0；日志 `/tmp/notalone-02-sql-modules-public.log`。


### 主 Agent 最终核验

- 已亲读接入及修复 diff；桌面相关检查 70/70、时间戳 NodeTS/CJS 单例 1/1、真实注册动作 storage trace 3/3 通过。
- 两轴审查：Standards 无新增问题；Spec 的首次惰性时间戳问题已由 `c448e3ca1` 修复并按原路径独立复核通过；模块分类补正为 `5ead41501`。
- 真实开发 App 与 `pnpm run diag --trace` 验收通过，当前读取未再出现旧失效误报；历史链路以原版本隔离 20ms HTTP 超时复现，不能据此补写过去未留存的现场日志。
- 达到当前约定范围，State 置为 resolved；后续模块接入和最终整体开销复测另由 03/04 执行。

### 共享 SQL 聚合器后续补修（2026-11-11）

- 原聚合器的 128 条模板统计槽会让第 129 条慢模板在进入运输前丢失，即使下游已分开调试与决策预算仍无告警。独立合成时钟回归分别以第 129 模板单次 1500 ms、三次 400+350+250 ms 复现，原实现两例均没有 `sql.slow`，修复后均正确保留。
- 现每动作最多统计 4096 个 SHA256 指纹，只保存指纹、次数、耗时，不保留原始 SQL 字符串；最多 128 条普通 debug 模板是明确采样，不占累计慢 SQL 的独立 4096 条决策输出预算。所有已统计模板都能累计跨越 1000 ms，调试模板不能先占掉慢查询资格。
- 超过统计硬上限后，最多额外保留 128 条单次慢观察，告警只报告该次 `count=1` 和实际观测耗时；此前未统计的快调用不冒称完整累计。`diagnostics.error(reasonCode=budget_exhausted, caller=sqlite_worker/sqlite_readonly_worker)` 的 count 精确计未统计的调用及被裁掉的单次慢观察；已成功保留的 warn、普通 debug 输出采样都不重复计为损失。统计外 400+400 后再观察到 1500 ms 的用例明确为丢失 2 次、warn count 1／1500 ms。
- 新独立 `backend-ts/test/unified-diagnostic-sql-priority.test.mjs` 5/5：含第 129 单次／累计慢、4096 统计硬上限、128 条统计外补充封顶，以及真实 publisher→私有 writer 链完整保留 4096 条 warn 和精确损失 2 条。实际日志文件不含 SQL 原文及敏感合成业务返回值。阈值／累计使用合成时钟，不能作为 SQLite 性能数据。
- 最小单例 red→green 后，`cd backend-ts && pnpm run typecheck && node --test test/unified-diagnostic-sql-priority.test.mjs test/unified-trace-storage.test.mjs test/unified-diagnostic-growth.test.mjs`：typecheck 退出 0、13/13 通过；日志 `/tmp/notalone-02-sql-priority-related.log`，独立测试日志 `/tmp/notalone-02-sql-priority.log`。没有改事件契约、04 文件、原三处 WIP、真实资料或桌面运行。
- 单独本地修复提交 `74a02d5b2` 只含聚合器与新独立测试两文件，未 push；runtime 冻结。02 已有 resolved 状态保持不重开；统计硬上限外仍不能保证完整累计，明确损失提示保留该限制。
- 提交后 `node scripts/check_public_history.mjs --ref HEAD --working-tree` 退出 0、命中 0；日志 `/tmp/notalone-02-sql-priority-public.log`。


### 本轮重新执行的实际 App／diag 验收（2026-11-11）

本轮先运行 `pnpm --dir desktop run dev:status`，返回stopped/exit1后，唯一启动入口使用 `pnpm run dev`；启动后再次status为development。实际记忆页选中联系人编号前缀 `1c43e3c0`，然后在已选范围重新打开记忆页，隔离出唯一一次main management_read。AX核对选择仍有效、加载结束、没有资料资格或连接变化提示；未输出界面正文或姓名。

真实执行命令（仓库根目录）：

- `pnpm run diag --since 5m --module memory.management`：exit0，用实际事件定位本次唯一读取编号。
- `pnpm run diag --trace 781dda27-fa90-481f-bc35-8e7d5b5e6786`：exit0，51条、main/backend齐全，45条SQL汇总合计4948次调用。逐条注册表校验通过，同一编号下main读取、main HTTP和backend读取均有且仅有一对started/finished，发生时刻顺序成立；没有request.failed，没有关联management/lifecycle失效广播，故本次不存在可归因的失效触发源。结论对应本次读取完成和查询时段，不把随后验收的正常退出/清除当作读取错误。
- `pnpm run diag --trace 781dda27-fa90-481f-bc35-8e7d5b5e6786 --slow`：exit0，0条；本次耗时低于现行慢请求阈值。
- `pnpm run diag --since 5m --slow`：exit0，38条；确实返回近期其它慢事件，非用空结果冒充功能已覆盖。

从真实命令输出仅投影编号、原因码、耗时（main读取／main HTTP／backend读取依次）：

```json
{"traceId":"781dda27-fa90-481f-bc35-8e7d5b5e6786","reasonCode":"request_completed","durationMs":560.509333}
{"traceId":"781dda27-fa90-481f-bc35-8e7d5b5e6786","reasonCode":"request_completed","durationMs":560.212292}
{"traceId":"781dda27-fa90-481f-bc35-8e7d5b5e6786","reasonCode":"request_completed","durationMs":559.348833}
{"traceId":"e684b0ad-6d11-42a4-87de-4276bfc0e875","reasonCode":"request_slow","durationMs":1281.508209}
```

本轮没有发现断链或缺事件，无需修改代码；仅补充ignored任务记录。实际诊断命令输出与投影统计保存为本轮私有0600验收证据，之后设置清除操作会删除产品日志，故已先保留这次查询快照；不包含聊天、记忆正文、昵称、路径、凭据或异常原文。State保持resolved。

本轮追加身份核对：经当前App的本机认证只读目录接口，仅在内存核对唯一展示名对应编号，真实输出为targetUnique=true、contactPrefix=1c43e3c0、status=200，exit0；没有输出或保存昵称、目录原文或认证凭据。上述唯一读取与用户指定编号一致。
