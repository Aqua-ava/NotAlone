# 退役审计报告

2026-11-10，worktree `audit/retirement-audit`（f14eb194f）。行号以该分支为准。

## 问题 1：模型许可仲裁能否简化

### 证据：进程拓扑

- 生产环境只有两级进程：桌面主进程经 `launchDsh` 派生唯一 DSH worker（`desktop/src/main/backend/process.ts:26` → `backend-ts/src/launch.ts:173` spawn `@deepseek-ai/dsh/lib/bin.js --profile notalone`）。已按 DSH 查证流程核对安装版本 `0.2.1-rc.2`（`backend-ts/package.json`/lock 一致），官方包 `dsh/dsh-agent/dsh-agent-loop/dsh-llm/cordis` 产物中无 `child_process` 调用，agent 循环在本进程内执行。
- 许可宿主与所有申请方同处该 worker 进程：`src/sqlite-host-plugin.ts:239-247` 在同一插件装配 `createSqliteModelRuntime`（宿主+arbiter+provider）与 `createSqliteMemoryRuntime`；memory 侧只复用共享 permit 端点（`src/memory/sqlite/README.md:21`）。
- 两类申请：回复前台进程内直取 `arbiter.acquire('foreground',signal)`，不带 worker 身份（`src/reply/sqlite/generation.ts:56` + `host/sqlite-model-runtime.ts:26` 注入同一实例）；记忆提取/文档/裁决经 socket 申请 background，附 `worker:{pid:process.pid,...}`（`src/memory/extraction/model.ts:144`、`scenarios/model.ts:148`）。跨进程场景只存在于测试合成（`test/sqlite-memory-model-port.test.mjs:116`、`test/sqlite-memory-adjudication-model-port.test.mjs:78`）；`src/` 中 spawn 仅剩原生探针与前台线程，无第二申请方。
- journal 是重复防御：崩溃后未结算恢复的权威记录在 SQLite 账本——`model_call.settlement_state ∈ reserved/settled/unknown`（`src/memory/sqlite/schema.ts:117`），中途失败落 unknown（`memory/sqlite/execution.ts:204,240`、`control.ts:208`），`unconfirmed_requests` op 由账本查询供数（`execution.ts:181` → `model-permit-server.ts:80-87`）。journal 的三个出口均无生产消费方：`unknownSettlements`/`unconfirmedPermitIds` 只从 `model-host.ts:77-78` 返回无人使用；`assertModelPermitJournalSettled`（`model-permit-journal.ts:31`）全仓零调用。
- ps 核对（`platform/process/process-identity.ts:10` `/bin/ps`）三个用途：① 每次 socket acquire 校验申请方身份（`model-permit-server.ts:104`）——宿主即申请方，属自检；② journal 复苏检查（`model-permit-journal.ts:47-100`）；③ `launch.ts:72-78` 兜底回收 `legacy.pid`（`launch.ts:94` 读、当前代码无写方，纯退役过渡残留）。

### 结论

确实只有一个进程申请许可。信号量本身（`ModelPermitArbiter`，`model-permits.ts`）设计与实现良好，应保留；跨进程 socket、落盘 journal 与 ps 核对在现拓扑下的安全收益接近零，成本是每批模型调用一次 TCP 往返、每次 acquire 一次 `ps` 子进程（约几十毫秒级），以及 395 行防御代码。

- 方案 A（保持现状）：无代码收益，继续为假想的第二进程付运行成本。不推荐。
- 方案 B（去 journal+ps、留 socket）：省 `process-identity`/journal 共约 200 行且 socket 协议保留"断线即孤儿"语义，但保留了无必要的 IPC 与自检身份字段，改动量与方案 C 相当，收益打折。不推荐。
- 方案 C（整体进程内）：删 `model-permit-server.ts`（148 行）、`model-permit-journal.ts`（121 行）、`process-identity.ts`（38 行）；memory 各调用方改注入进程内许可端口（ acquire/settle/orphan 直接返回），`EXTRACTION_PERMIT_ENDPOINT` 的 socket/token 配置及 `sqlite-model-config.ts:7`、`sqlite-model-runtime.ts:15` 的 env 门禁同步收敛；`launch.ts` 删除 `retiredProcessStopped`/`stopPid`（连同 `legacy.pid` 读取）。`ModelPermitArbiter`、SQLite 账本、accounting 三件套不动。

### 风险

- 孤儿语义换轨：socket close 触发 `permit.orphan()`（`model-permit-server.ts:46-51`），进程内需改为调用方 AbortSignal/finally 显式 orphan，需用合成回归覆盖"断线冻结同类"用例（`test/model-permits-lanes.test.mjs`）。
- 大量协议测试退役（`model-permit-socket/lanes/test/model-task-claim/model-mode-recovery`），属删绿代码，需确认无迁移账本式外部依赖。
- `assertExtractionPolicyWindow` 等无关；`NOTALONE_MODEL_PERMIT_*` env 若被用户配置残留会因门禁收紧而报错，属预期失败。
- 需要用户决定：是否接受每次改动后的桌面验收（不含发送）；若未来出现真正的第二运行时宿主需重新评估。

**建议：做（方案 C），分两步：先删 `assertModelPermitJournalSettled` 与 launch 旧回收（无风险），再换进程内端口并退役 socket/journal/ps。**

## 问题 2：三套核验策略能否只留一套

### 证据：当前路径

- 新任务一律 v2 config：`newTaskConfig()` 返回 `verification_policy:'complete-claim-v1'`（`src/memory/extraction/policy-version.ts:108`），resolve 到 `complete-claim-v1`（同文件:46-49）；准入门只接受 `multimodal-claim-v1` 与 `complete-claim-v1`，其余策略 `return null`（`src/memory/sqlite/service.ts:334-335`）。
- 旧策略可达性：`legacy-v4` 仅当存量 run 存有 v1 mode-legacy config 时由 `prepareSourceVerification` 选中（`verification/complete-claim.ts:267,274`）；`nullable-proof-v3` 仅当存量 config 为 `bounded-runtime-v1` 时 `runBoundedExtractionFlow`（`flow.ts:106,251`）执行。恢复/继续路径对 undefined stamp 只做"按新 v2 重启"，对非法 `{}` 配置逐候选跳过（`service.ts:152-158,222-228`）——旧策略只服务重放，且重放入口已近乎不可达。

### 证据：真实库存量（ro 只读聚合）

- `processing_run.policy_config`：59 条 v2/complete-claim-v1；38 条为无版本键的空对象（旧于配置机制的 `{}`），其状态 34 failed、3 completed、1 incomplete——按现行 resolve 会抛 `extraction_runtime_config_invalid` 被跳过，不可能重放进旧策略。
- 全部 5342 条 `execution_event` 载荷中 `bounded-runtime-v1`、`rule_set_sha256` 命中 0；verification 系列事件中 `legacy-v4`/`nullable-proof-v3` 命中 0，`complete-claim-v1` 命中 826、`multimodal-claim-v1` 6、`request_fingerprint` 131。
- 181 条 `verified_output` 事件载荷均不含 `dimension_evidence`（`candidate_sha256`/`window_sha256`/`claim_validation` 命中皆 0）：证据摘要从未落库。adoption 管道把 `dimension_evidence` 当不透明 Record（`src/memory/adoption/contracts.ts:8-9`）；`buildDimensionEvidence`/`buildBoundedDimensionEvidence`/`bindDimensionEvidence`/`attachVerifiedSourceReceipt` 在 `evidence.ts` 之外零调用，`candidateDigest`/`pythonFloat` 只被这几个未调用函数使用。v1 与 v4 两套摘要是双亡代码，与重放无关。

### 结论

运行库中三套策略并存是纯代码遗迹：真实库从 v1 到 v2 期间从未留下 legacy-v4/nullable-proof-v3 或证据摘要痕迹，且现行恢复逻辑对旧配置是"重启"而非"重放"。

### 需保留的最小代码

- `policy-version.ts` 的 v1 校验与窗口断言收紧路径（明确拒绝旧 config，避免静默错跑），即 `validateExtractionRuntimeConfig` 的 else-throw 与 `assertExtractionPolicyWindow:63`。
- `complete-claim.ts` 内 `VerificationPolicyId` 窄化为 `complete-claim-v1`；multimodal 就地保留（库中有 6 条）。
- 服务级 `restartPolicy` 分支（source_unavailable → v2 重启）。

### 建议改动涉及文件

`memory/extraction/policy-version.ts`（删 LegacyRuntimeConfig 分派）、`verification/complete-claim.ts`（删 legacy-v4/nullable-proof-v3 分支与默认 `{id:'legacy-v4'}`）、`verification/bounded-proof.ts`（整删 207 行）、`extraction/flow.ts`（删 `runBoundedExtractionFlow` 约 110 行）、`extraction/contract.ts`（SOURCE_VERIFICATION_CONTRACTS 收留 complete 分支）、`verification/evidence.ts`（删 build/bind/attach 与 candidateDigest/pythonFloat，视 `evidenceTimestamp` 是否仍被外部使用）、`protocol.ts`/`bounded.ts` 相应死分支、`memory/sqlite/README.md`。

### 风险

- 今后若引入全新 lib 或导入旧机器库，需重评删除决定（该路径的丢失面是"旧库重放"而非运行功能）。
- `release` 版本标识链（sourceStamp capture 依赖入口文件集合，`policy-version.ts:84`）变化会触发存量 run 重启，删除文件不影响 v2 身份计算正确性但会改变 stamp，需一次性重启回归。
- 无界面/文案改动；风险集中在回归测试重写（多种策略用例退役）。

**建议：做。可删 legacy-v4、nullable-proof-v3 与整套 v1/v4 证据摘要；旧 config 保留显式拒绝，不做任何重放保留。**

## 问题 3：一次性代码能否移出运行时

### 证据：cutover 不是退役遗留而是现行控制面

- 每次桌面启动都执行：`desktop/src/main/startup/diagnostics.ts:20` 构建 `SqliteDevelopmentProbe`，`sqlite-development.ts:52-60` spawn 探针运行 `prepareDefaultDatabaseStartup`（`platform/cutover/startup.ts:85`），执行发现未知受控项、manifest 加载、技能根搬迁恢复、打开同一实例并写启动配置（`startup.ts:94-129`）。1114 行中约 160 行（targets 分类、cleanup）仅在存在旧目标时生效，其余每次启动都跑。
- `phase` 状态机含 `switched/completed`（`contracts.ts:11`），completed 后每次启动走快路径（`startup.ts:109-113`），切换不可逆（manifest 成为持久开关）。控制动作仍注册进 storage 动作面（`storage/sqlite/registry.ts:64,86` cutoverActions），`control.ts` 同时服务 Skill 根搬迁（`skills/sqlite/root-relocation.ts:12,165`）。无法仅凭代码断言本机 manifest 是否 completed，故不能宣称"切换已完成"。
- 迁移账本全部冻结：`worker.ts:86` 校验迁移条数、逐条 version、checksum 与注册表一致，任何现存库对旧迁移源码有永久校验关系；本机已应用 47/47 条（真实库 `schema_migration` count=47,max=47）。迁移 47 即 `historyRetirementMigration(47)`（`registry.ts` 末项；`migrations/history-retirement-schema.ts:2`）。
- 迁移 47 的 SQL 调用两个 JS 函数（`history-retirement-schema.ts:15,18` → `worker.ts:72-73` 注册 `notalone_history_deletion_equivalences_v1`/`notalone_history_retired_deletion_operations_v1`），实现位于 `migrations/history-retirement-v1.ts:31,62`。新装机从 create 起完整重放迁移，故这两个函数及其依赖链（`history-legacy-proof-v1.ts` 的 digest/校验，仅被迁移链引用）必须永久保留。
- 运行时引用面：`history-source-proof`（46）与 `history-superseded`（45，ADR-175）的表在现行查询中活跃（`source_proof` 真实库 16 行）；`history-recertify`（29/30）只剩账本。

### 删除清单（可删）

- `launch.ts` 的 `retiredProcessStopped`/`stopPid` 与 `legacy.pid` 读取（`launch.ts:72-99`）：无当前写方，纯退役过渡。
- 问题 1 方案 C 下的许可配套（journal、ps、socket）。
- 测试用 `historical-inventory.json` 中对应登记的旧执行器用例可随实现一并退役（无运行时引用）。

### 保留清单（必留，附理由)

- 全部 18 个迁移文件与 `worker.ts:72-73` 两个 SQL 函数：账本校验与 create 重放需要；源码惰性注册（只在 create/待迁移时注册函数）是可选优化，不可作为删除。
- `platform/cutover/` 整目录：现行启动控制面与 Skill 根搬迁依赖；不可按行号整块删除。
- `inspect.ts` cutoverActions：注册进 registry 的运行时动作。

**建议：部分做。迁移记账维持冻结不动；cutover 不移出运行时但可单列一张后续票评估"completed 快路径简化"；可删 launch 旧回收。是否删除 cutover 需要用户确认本机切换实物状态后另行决策。**

## 问题 4：失败码是否可以收敛

### 证据：产出面 vs 判别面

- 产出：`backend-ts/src+test` 中 254 个不同 StorageFailure 码、461 个不同 `fail()` 码（regex 抽取，与任务口径 ~296/456 同量级）。域分布：history 103、memory 79、discussion 65、media 56、document 55。
- 判别：`src+desktop` 中按字面比较 `.code`/switch/case 的字面量共 57 个；与产出集相交仅 9 个 StorageFailure 码与 17 个 fail 码真被分支（例：`deletion_busy`、`history_image_key_unavailable`、`memory_conditions_pending`、`memory_extraction_receipt_unknown`、`skill_revision_conflict`、`quarantine_cursor_invalid`、`identity_continuity_unverified`）。判别面/产出面约 4%——其余 ~95% 只被透传、记日志或以"未知错误"兜底。
- 桌面端少量按码文案表：`desktop/src/main/startup/sqlite-development.ts:19-20`（12 个 cutover/maintenance 码）→ `StartupSettings.tsx:66,83-84` startupMessages；`sync-scope-notice.ts`、Trace/History/Clear 面板各一张小表。绝大多数码不进 UI，只进日志/诊断事件。

### 结论

全局收敛不值得：近 300+450 个码承担的是"日志与人类可读诊断"的精度价值，代价极低；按处理方式分支的码本就极少。值得收敛的是已被分支的那一小部分与"将来可能被分支"的域级提示：
- 每个域保留 2-4 个面向处理方式的码（如 `*_transient`/`*_stale`/`*_unverified`/`*_conflict`），其余并入域内大类（`history_*` → `history_domain_conflict` 等）并把原码放诊断字段 `detail.code`。
- 存量兼容：`execution_event.payload` 与桌面诊断面板存有旧码字面量，收敛需保持旧码→新类别映射可读，不能改写历史事件。

### 风险

- 一次性大改会破坏现有日志 grep 习惯与按码断言的测试映射；建议按域逐张提交、每次只动低判别面域。
- 桌面文案表与 `test:app` UI 断言需随收敛同步；不涉及产品硬边界。

**建议：基本不做；若做按域渐进收敛为每域 2-4 个过程级码，无须用户现在决定，可作为后续独立票。**
