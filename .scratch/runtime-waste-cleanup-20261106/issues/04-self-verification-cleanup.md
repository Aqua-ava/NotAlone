# 合并重复哈希封装、去掉确认冗余的重复校验

Triage: ready-for-human（B1 简化待裁决；A4 按语义判定保持逐个核验；probe.test.mjs 完整流程用例为既有失败需另修）
State: resolved
Type: task（分级重构，每级独立提交）

Blocked by: none。**改动文件分散在 `backend-ts/src` 多处，不要与其他修改 `backend-ts/src` 的 Agent 并行。**

先读 [spec.md](../spec.md) 的"全局规则"，再开始。

## Goal

清掉"确认是冗余"的重复哈希封装和重复校验，使代码更少、更好读；**不削弱任何有产品意义的校验**。本任务的收益主要是可维护性，CPU 收益很小（见下方实测），所以：

- 每一项都要先写出"这个校验防的是什么、谁能触发那种情况"，说不清的**保留**。
- 没有可测收益时如实写"无可测收益，仅减少代码"，不要宣称提速。

## 实测背景（11-06 本机 Node v24.22.2）

| 项目 | 实测 |
| --- | --- |
| sha256 5 MB / 40 MB | 1.6 ms / 12.8 ms |
| `createExtractionPolicyVersion` 首次捕获 / `assertCurrent` 每次 | 17.5 ms / 4.9 ms（`backend-ts` 内 `memory/extraction/policy-version.ts`） |
| `synchronous=FULL` 与 `NORMAL` 每次写事务 | 0.043 ms / 0.008 ms（WAL，本机 tmp） |
| 启动校验 helper：每个 helper 2 次 `codesign` | 约 36 ms/个；共 4 个 → 约 150 ms |

可直接复用的基准脚本：[bench/bench-policy.mjs](../bench/bench-policy.mjs)、[bench/bench-sync.mjs](../bench/bench-sync.mjs)（合成数据，无私人资料）。

## 铁律：不得改变任何已持久化摘要

下列摘要的**输入序列化和输出**已经写进真实库或被启动校验使用，改动会让既有库报 `schema_drift`／`migration_drift`／`stored_request_mismatch` 等错误：

- `schema_migration.checksum`（`digest(migration.sql)`）、`database_instance.schema_digest`（`worker.ts:13,56,115,120`、`readonly-worker.ts:12,46,49`）。
- `model_operation.input_seal`、`execution_event` 载荷摘要（`memory/sqlite/execution.ts:119`、`memory/sqlite/documents/basis.ts:101,135`、`reply/sqlite/turns.ts:63`）。
- `cursor_scope_digest`（`history/sqlite/cursor.ts:45`）、删除目标 `identity`／`address`（各 `*/deletion.ts`）、媒体文件 `sha256`、技能包 `package_sha256`／`manifestDigest`／`contentDigest`。
- `policy-version` 的 `sourceStamp` 与 `rule_version`（写入抽取任务配置）。

因此 **A1 只允许合并"`createHash('sha256').update(x).digest('hex')` 这一层封装"，不得改动各处传入 `update()` 的序列化方式**（`JSON.stringify` 的 replacer、键排序、`canonical()` 等一律原样保留）。每处替换后用**固定输入的黄金摘要**证明输出逐字节相同。

## 分级清单

### A 级（预期安全，可直接做，分别提交）

**A1 合并哈希封装**

现状：约 25 个文件各自定义同形的局部函数（`digest`／`sha`／`hash`／`sha256`／`seal`／`fingerprint`），例如 `storage/sqlite/worker.ts:13`、`storage/sqlite/readonly-worker.ts:12`、`storage/sqlite/deletion/actions.ts:21`、`reply/sqlite/deletion.ts:12`、`history/sqlite/boundary.ts:54`、`history/wechat/native-client.ts:154`、`media/voice/adapter.ts:10`、`media/visual/image-tools.ts:13`、`platform/models/model-images.ts:16`、`memory/sqlite/documents/stages.ts:22`。已有两个现成的公共实现：`memory/evidence/canonical-json.ts:45` 的 `sha(value:string)` 与 `skills/skill-package.ts:16` 的 `sha256(bytes: string | Uint8Array)`。

做法：

1. 先用 `rg -n "createHash\(" backend-ts/src desktop/src` 列出全部调用点，**逐个**判断属于哪类：(i) 纯 `sha256 → hex` 一次性封装，可替换；(ii) 流式／分块哈希（`media/sqlite/files.ts:31,54`、`media/visual/adapter.ts:27`、`media/visual/wechat.ts:101`、`bundled-helpers.ts:80`），保持原样；(iii) `sha1`（`memory/scenarios/workspace.ts:163` 的 UUID v5 生成，保持原样）；(iv) 桌面端（`desktop/src/main/...`），除非有共享位置否则**不跨包合并**。
2. 选一个公共位置（优先复用上面两个已有函数之一，必要时放进 `backend-ts/src/platform/` 下一个小模块），只替换(i)类。
3. 黄金摘要测试：在 `backend-ts/test/` 新增测试，对每个被替换的封装喂固定输入（空串、ASCII、中文、含 `\0`、`Uint8Array`），断言与替换前实现逐字节相同。**先在替换前把期望值从旧实现生成并写死进测试。**
4. 报告：删除的重复定义数量、净减行数。

**A2 媒体预览路径只读一次**

`backend-ts/src/media/sqlite/files.ts:51-63`：

- `verify()` 整读文件算 sha256；
- `preview()` 先调 `verify()`，再 `readFile()`，再对整份数据算一遍 sha256。

同一文件被读两遍、哈希两遍。改为：`open` 一次 → `stat` 校验 `nlink`／`ino`／`size`（保留 `media_file_identity_changed` 语义）→ `readFile` 一次 → 只哈希一次并比较。调用方：`media/sqlite/service.ts:163,173`。

**不要改**写入路径（`:25-50`）里"写入时算一遍 + `handle.sync()` + 校验后独立复读"：该处注释写明"类型探针不能改变刚校验的副本；独立复读完整性"，防的是磁盘写入或探针副作用，属于完整性校验，保留。

测试：`backend-ts/test/sqlite-media.test.mjs`、`sqlite-managed-file-identity.test.mjs`、`sqlite-media-deletion.test.mjs`、`sqlite-visual-media.test.mjs`，并补一条"预览只读一次"的断言（例如包装 `FileHandle` 计数 `read` 次数）。

**A3 启动期 helper 核验只做一次**

`desktop/src/main/backend/bundled-helpers.ts` 的 `verifiedBundledRuntime()` 被两个入口各调一次：`resolveSyncProbePath`（`desktop/src/main/backend/config.ts:80`）和 `resolveHeaderChangeSourcePath`（`desktop/src/main/index.ts:130`）。每次都：解析清单 → 哈希最多 64 个文件 → 对 2 个可执行文件各跑 `codesign --verify` ＋ `codesign --display`。同一进程启动期内重复两遍。

改为按 `resourcesDirectory` 记忆**同一次启动内**的校验结果（模块级 `Map<string, Promise<BundledRuntime|undefined>>`）。要求：

- 不得跨进程或跨启动缓存；不得削弱校验内容；失败结果也同样记忆（避免重复报错）。
- 保持对 `resolveSyncProbePath` 里配置路径分支的既有行为（`bundled-helpers.ts:15-30`）。
- 用 `desktop/tests/helpers/probe.test.mjs`、`header-change-source-process.test.mjs`、`header-change-diagnostics.test.mjs` 回归；补一条"同一资源目录两次解析只执行一次 `codesign`"的测试（注入 `execute`）。
- 测量：启动期节省的毫秒数（预期约 75 ms，如实写测得值）。

**A4 技能 anchor 批量核验**

`backend-ts/src/reply/sqlite/turns.ts:30` 与 `backend-ts/src/reply/sqlite/candidates/turns.ts:34` 都是 `for (const anchor of eligible) await library.assertAnchor(anchor)`。`assertAnchor` → `assertAnchors([anchor])`（`skills/sqlite/library.ts:174-185`）每次做"数据库复验 → 读目录快照 → 数据库复验"，N 个 anchor 就是 N 倍。已有批量接口 `assertAnchors(anchors, signal, catalog)` 接受数组。

改为一次 `assertAnchors(eligible)`。**先确认语义等价**：批量版对每个 anchor 的校验项、失败时抛出的错误类型与"记录问题"副作用（`recordProblem`）与逐个版一致；若失败顺序或副作用不同，保持逐个版并在报告里说明原因。测试：`backend-ts/test` 里搜 `assertAnchor`、`skill-run` 相关用例（`rg -l "assertAnchor" backend-ts/test`）。

### B 级（可能承担产品意义，**只做分析，写进报告，等用户裁决后才改**）

**B1 `bundled-helpers.ts` 的 `validRepositoryBuild` 硬编码白名单**

`desktop/src/main/backend/bundled-helpers.ts:111-141`：启动时用硬编码的 Swift 源文件正则、`[8,9,11,12,...,20]` 的允许文件个数和一长串"文件 A 存在则文件 B 必须存在"的组合规则，校验应用**自带**的构建清单。这是应用对自己构建产物的自检，每新增一个 Swift 源文件都必须同步改这里，是维护陷阱。
候选简化：保留 `buildSourceDigest === sha256(JSON.stringify(buildSources))` 和每个源文件 `sha256` 格式检查，去掉组合依赖规则与个数白名单。
**必须先回答**：这个清单校验防的是什么威胁？（构建脚本产出不完整？包被篡改？）若是后者，攻击者能改包就能同时改这段代码，自检无意义；若是前者，构建脚本测试更合适。写出结论让用户裁决。

**B2 `policy-version.assertCurrent`**

`backend-ts/src/memory/extraction/policy-version.ts:82-112`：每次调用都重读并哈希入口文件的整个 import 依赖树，约 5 ms/次；调用点 `memory/sqlite/service.ts:98,118,131,144,167,207`，以及抽取每个窗口的 `requireCurrent`（`:266`）。用途是"抽取运行期间源码被改动则中止"，实际只在开发热更新时有意义，打包版源码不可变。
候选：用文件 `mtime`＋`size` 做廉价预检，变化时才重哈希；或打包版跳过。
**默认建议不改**：收益约 5 ms／窗口，远小于一次模型调用；只有当 A 级完成后你有数据证明它占抽取总耗时超过 1% 才值得做。写出占比。

**B3 图片字节在一次请求内被多次解码和哈希**

- `memory/extraction/multimodal.ts:155`：逐图 `Buffer.from(base64)` + sha256，与期望比对。
- `platform/models/model-images.ts:16`：另一处 `digest(bytes)`。
- `platform/models/model-input-budget.ts:50-58,60`：再做一次 base64 往返检查（`Buffer.from(data,'base64').toString('base64')!==data`）并 sha256 比对清单。

同一张图在一次请求里可能被解码、哈希 ≥3 次。可让清单携带已算好的摘要并只比对。先测：5 MB 图片约 1.6 ms 哈希＋数毫秒解码，窗口内图片数一般很少，**除非实测占准备耗时 >5% 否则不改**。

**B4 其余"自证式"摘要**

`memory/sqlite/documents/basis.ts:101`（用同进程刚存的请求重算摘要，与 `input_seal` 比对）与 `memory/sqlite/execution.ts:119-122`（同一操作槽位若请求变化则 `memory_extraction_operation_changed`）。注意：`input_seal` 同时承担**幂等重放判定**与**删除标记**（`documents/deletion.ts:233,263` 把它改写为 `'deleted'`；`reply/sqlite/model-deletion.ts:36` 依赖该值）。**不要删除或弱化 `input_seal`**。只有 `basis.ts:101` 这种"读出自己存的载荷再校验"是否多余需要论证，且该库可能被旧版本写入或被人工修复，论证要把这点考虑进去。写出结论，默认保留。

### C 级（明确不动）

- 删除证明、`owner_id + contact_id` 隔离、来源核验、围栏／代次检查、`assertReadEligibility`、`assertSourceEligibility`。
- 迁移 checksum 与 `schema_digest` 的启动校验（保护真实库，开销以毫秒计）。
- 媒体写入路径的写后复读校验。
- `synchronous=FULL`、`secure_delete=ON`。

## 步骤

1. 新建 `backend-ts/scripts/perf/` 下的基准（或直接用 [bench/](../bench/) 里两份脚本）记录 A 级各项修改**前**的基线。
2. 逐项做 A1 → A4，**每项一个提交**，每项先写测试（红）再改（绿），再跑受影响的测试文件。
3. B 级只写分析，产出 `docs/verification/self-verification-review-20261106.md`：每项一节，包含"防什么、谁会触发、现有测试是否覆盖、移除风险、测得收益、建议（改／不改）"。**不要改 B 级代码。**
4. 全部 A 级完成后，跑一次 `cd backend-ts && npm test`（带时间上限）和 `cd desktop && npm run typecheck`，确认无回归。

## 验收

- [ ] A1：重复定义已合并，黄金摘要测试证明每处替换输出逐字节一致；没有任何调用点的序列化被改动；打开一份真实库的隔离副本不报 `schema_drift`／`migration_drift`。
- [ ] A2：预览路径对同一文件只读一次、只哈希一次，`media_file_identity_changed` 与 `media_copy_incomplete` 语义保持；写入路径未改。
- [ ] A3：同一次启动内 `codesign` 校验只执行一次；校验内容和失败行为未变；已记录节省毫秒数。
- [ ] A4：确认语义等价后改为批量核验，或记录了不等价原因并保持原样。
- [ ] B 级报告已写，每项有"改／不改"建议和测得数据；**没有改动任何 B 级代码**。
- [ ] 每项 A 级改动都有"前后对比"：行数、耗时或"无可测收益"。
- [ ] 数据处理影响已写明（预期：无；不改变任何持久化摘要、不改变存储格式）。
- [ ] 每个 A 项一个本地提交，只含该项变更；未触碰工作树里用户已有的改动文件。

## Test seam

- A1：新增的黄金摘要测试（公开的哈希封装函数）。
- A2：`MediaFiles.preview` 的公开行为（返回字节、抛出的 `StorageFailure` 代码）。
- A3：`resolveSyncProbePath`／`resolveHeaderChangeSourcePath` 的公开解析结果和 `execute` 调用次数。
- A4：`SqliteDiscussionTurns.configurationFor` 与候选回复 `turns` 的公开行为。

## 常用命令

```bash
node backend-ts/../.scratch/runtime-waste-cleanup-20261106/bench/bench-policy.mjs
cd backend-ts && node --test test/sqlite-media.test.mjs test/sqlite-managed-file-identity.test.mjs
cd backend-ts && node --test test/sqlite-storage.test.mjs test/sqlite-incremental-migration.test.mjs
cd desktop && node --test tests/helpers/probe.test.mjs tests/header-change-source-process.test.mjs
cd desktop && npm run typecheck
```

## 停止条件

- 某项校验无法说清防的是什么：保留，写进 B 级报告。
- 替换哈希封装会改变任何已持久化摘要的值。
- 需要改变存储格式、迁移或删除证明。

## Answer

**A1 合并哈希封装 — 提交 8d2b0c369**
- 前后：`backend-ts/src` 内一次性 `createHash('sha256').update(x).digest('hex')` 调用点由约 76 行并入 56 处于唯一封装 [src/platform/sha256.ts](../../../backend-ts/src/platform/sha256.ts)（含 canonical-json.sha、skill-package.sha256 改为复用同一实现；含 documents/schema.ts、management/adjudication-schema.ts 两处模块级 checksum 常量）。删除纯同名封装定义 7 个（storage/sqlite/worker、readonly-worker、history/sqlite/boundary、history/wechat/native-client、media/voice/adapter、media/visual/image-tools、platform/models/model-images）；复合封装（stages、management/actions、adjudication-actions、pagination、checkpoint-cache、legacy-terminal-proof）委托到同一封装。`backend-ts/src` 净约 -37 行（47 文件 +89/-126；含新文件），desktop 端 8 处未动（(iv) 类）。
- 逐个分类：替换 (i) 类；保持 (ii) 流式/多段 update（media/sqlite/files.ts:32,55、media/visual/adapter.ts:28、media/visual/wechat.ts:102、skills/skill-files.ts:88、skill-package.ts:121）、(iii) sha1（memory/scenarios/workspace.ts:163）、(iv) 桌面端全部、二进制 digest()（launch.ts、model-permit-journal.ts）、scenarios/workspace.ts:145 因显式 `'utf8'` 编码参数按调用点原样保留、decoder-worker.mjs（独立 worker 进程加载路径，保守保留）。
- 真实验证：新增 [test/sqlite-hash-wrapper-golden.test.mjs](../../../backend-ts/test/sqlite-hash-wrapper-golden.test.mjs)，期望值在替换前从旧实现写死（空串／ASCII／中文／含 \0／emoji／多行／Uint8Array／4KiB 字节），断言逐字节一致并通过现时 createHash 对照；tsc --noEmit 通过；storage/migration/skills/media×4/history-runtime/model-input-budget/model-host/golden 共 11 个测试文件 104 用例全绿。
- 其他各删除身份/地址封装（各 */deletion.ts、storage/sqlite/deletion/actions.ts、reply/sqlite/model-deletion.ts）属已持久化删除目标摘要且合并零行收益，保持原样。

**A2 媒体预览只读一次 — 提交 6685e7d9c**
- 前后：`MediaFiles.preview` 由"verify 整读哈希＋重新 open 复读哈希"（同一文件读两遍、哈希两遍）改为 open 一次 → stat 核对 nlink/ino/size → readFile 一次 → 哈希一次比对；`media_file_identity_changed`／`media_copy_incomplete` 语义不变；写入路径"写入时算一遍＋handle.sync()＋独立复读"未动。
- 真实验证：新增"预览只读一次"断言（FileHandle 原型计数：预览 readFile 恰 1 次、createReadStream 0 次；verify 仍流式复读 1 次）；tsc 通过；sqlite-media / managed-file-identity / media-deletion / visual-media 46 用例全绿。

**A3 启动期 helper 核验只做一次 — 提交 588affa27**
- 前后：`verifiedBundledRuntime` 按模块级 `Map<resourcesDirectory, Promise>` 记忆同一次启动进程内的核验结果（成功与失败均记忆）；同一目录两个入口（resolveSyncProbePath、resolveHeaderChangeSourcePath）只执行一轮"清单校验+≤64 文件哈希+codesign"。校验内容与失败行为不变；新增仅测试使用的 `testCodesignExecutor` 注入替身。
- 真实验证：新测 tests/helpers/runtime-cache.test.mjs 断言同一资源目录两次解析＋header-change 入口共用结果，codesign 仅首轮 4 次（2 执行文件×verify+display），失败结果同样只执行 1 次；header-change-source-process／header-change-diagnostics 16 用例全绿；desktop npm run typecheck 通过。
- 测得耗时（真实 codesign，仓库准备资源）：冷核验 24.1ms/次（codesign 约 4.4ms/次×4 ≈17.6ms + 清单/哈希 ≈6.5ms），缓存命中≈0ms → 每次启动同一目录重复解析省约 **24ms**（低于任务预估 75ms，如实写）。
- 既有失败（与本任务无关）：tests/helpers/probe.test.mjs 完整流程用例在 6685e7d9c（本任务前一棵）复测同样失败（`paths.syncProbePath` 为空，现 StartupDiagnostics.getPaths→loadBackendConfiguration(userData) 不带 resources，与 bundled-helpers 无关）；已提交留档未改动。

**A4 技能 anchor 批量核验 — 提交 e70bbfe19（保持逐个版）**
- 语义判定：单失败路径上批量与逐个的错误类型、校验项、recordProblem 副作用一致；**多失败并发窗口不等价**——批量版首轮 `skills.assertRevisions` 对全部 anchor 复验，次序 anchor 的数据库失败先抛出，数组更前序 anchor 不再读目录、不触发 recordProblem；逐个版（调用点现状）先完整核验首序 anchor（目录失败时当场 recordProblem 置失效）再遇次序失败。错误优先次序与副作用时点不同，按任务单要求保持逐个核验。
- 真实验证：新增 test/sqlite-skill-anchor-verify-order.test.mjs 锁定当前批量语义（双失败窗口不记录首序问题；单 anchor 版照样记录 content_changed），为未来改批量提供依据；tsc 通过，2 用例全绿；本项提交只含测试。

**B 级报告**：[docs/verification/self-verification-review-20261106.md](../../../docs/verification/self-verification-review-20261106.md)（提交 26fa0fde4；未改任何 B 级代码）
- B1 validRepositoryBuild 白名单：建议简化（保留 buildSourceDigest 自一致与 sha256 格式检查，删正则/个数/组合规则），属构建自检而非安全边界 —— **待用户裁决**。
- B2 policy-version.assertCurrent：不改（实测 5.1ms/次，占单窗 <<1%，无端到端占比数据）。
- B3 图片多次解码/哈希：不改（本机 5MB 图三段 ≈9ms，未达 >5% 阈值）。
- B4 input_seal 复核/槽位复验：保留（删除证明与幂等边界，成本亚毫秒；旧版本写入与人工修复场景仍需读侧复核）。

**数据影响**：无。未改变任何已持久化摘要的输入与输出（黄金摘要测试逐字节断言）、未改变存储格式或错误码语义、未涉及真实库与用户资料（全部合成夹具）。

**验证命令**：
- `cd backend-ts && npx tsc --noEmit`（每项全绿）；各 A 项相关测试文件见上文分项（合计含 golden/storage/migration/skills/media×4/history-runtime/model-input-budget/model-host/A2A4 新增等 direct runs，全部通过）。
- 全量 `npm test`：本机当时同一时段有其他任务的重负载脚本与并发提交，整串 npm test 两次均在 40 分钟时限处被截断，无法在本会话出一体绿灯；改以**等价分桶扫描**覆盖 run-current 当前清单的 279 个测试文件（每桶 `node --test --test-concurrency=4`，与 run-current 同一份历史过滤与构建前置），全部桶均已执行并取得结果；其中被截断的少量重测文件重复跑后无未归因新失败。
- 分桶扫描发现的全部失败经与 `d4962fec0`（本任务任何提交之前）的隔离工作树复测逐一归因：**每一个观察到的失败在该基线同样失败或基线失败更多**（例：migration 升级链、assistant-read、memory-control、probe.test 整组流程等）；未发现任一失败仅在本任务提交后才出现。desktop `npm run typecheck` 通过，desktop 测试的既有失败仅 probe.test.mjs 完整流程用例（同样与本任务无关）。
- `node scripts/check_public_history.mjs --ref HEAD --working-tree`：原实现在 `git cat-file --batch` 单缓冲（512MB maxBuffer）上 ENOBUFS 报错（工具容量限制，仓库对象体随历史增长首次越过）；以同规则流式等价复检（/tmp 临时脚本，同排除/敏感值规则）确认 **issues=0**（历史 3371 commits／25002 blobs／当前 2272 files），本次提交无新增命中。

**剩余风险**：
1. A1 覆盖面广（45 文件），虽有黄金摘要与 104 用例，仍依赖全量 npm test 收尾确认；如有隐性依赖（例如按字符串匹配 createHash 的代码）需复核——已 rg 审核无此类。
2. A3 的 codesign 实测基于本机当前 Swift 产物时点；不同机器/包体积下节省毫秒数会不同（结构结论不变：重复码执行至少省一轮）。
3. probe.test.mjs 既有失败（与本任务无关）阻塞"仓库探针整组核验"用例的绿灯证据，需要另行修复任务。
4. B1 简化需用户裁决后另行提交；未裁决前维持现状。

## Comments

- 2026-11-07（本任务 Agent）：A1–A4 与 B 报告均已提交，见顶部 ## Answer 与四个提交（8d2b0c369、6685e7d9c、588affa27、e70bbfe19 + B 报告 26fa0fde4）。需要用户裁决的点：1）B1 白名单是否按报告建议简化；2）A4 未来是否接受"多失败并发窗口错误优先次序变化"再改批量（已用测试锁定现状语义）；3）probe.test.mjs 既有失败（与本任务无关，6685e7d9c 上复测同样失败）是否另开任务修复；4）`check_public_history.mjs` 在 obj-batch 单缓冲 512MB 上 ENOBUFS，本次以同规则流式等价复检 issues=0，工具脚本本身是否提高缓冲/改流式可另议。
- 全量回归口径补充：npm test 整串两次被后台时长截断，改分桶跑完 run-current 当前清单 279 文件；扫描发现的失败集与 `d4962fec0` 基线逐一对照，全部为既有失败（基线同样或更多失败），无归因本任务的失败。同样被截断过而补跑的文件（如 sqlite-memory-documents-* 系）重跑后除已归因的 L1 主题窗失败外全绿。
- 本任务各 A 项提交时的最小相关测试均于提交前全绿，提交哈希见 ## Answer；B 级零代码改动。
