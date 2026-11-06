# 自证式校验复核报告（任务 04 B 级：只分析，不改 B 级代码）

> 任务：[.scratch/runtime-waste-cleanup-20261106/issues/04-self-verification-cleanup.md](../../.scratch/runtime-waste-cleanup-20261106/issues/04-self-verification-cleanup.md)（任务单为 gitignored，仅当前检出可见）。
> 本报告只覆盖 B1–B4 分析；A1–A4 为独立提交（见提交 8d2b0c369、6685e7d9c、588affa27、e70bbfe19）。**未改动任何 B 级代码。**
> 测量环境：同一台本机（macOS 27 arm64，Node v24.22.2），基准脚本 `.scratch/runtime-waste-cleanup-20261106/bench/bench-policy.mjs`（合成数据，gitignored，仅当前检出可见），B3 用临时运行脚本测量、未新增仓库代码。

## B1 bundled-helpers 的 validRepositoryBuild 硬编码白名单

- 位置：[desktop/src/main/backend/bundled-helpers.ts:129](../../desktop/src/main/backend/bundled-helpers.ts)（A3 后行号；调用点 :80）。内容：Swift 源文件名正则白名单、允许文件个数 `[8..20]`、"文件 A 存在则 B 必须存在"组合规则与最小布局个数公式，最后 `buildSourceDigest===sha256(JSON.stringify(buildSources))` 与逐项 `sha256` 格式检查。
- 防什么：核验应用**自带**的探针构建清单（`Resources/notalone-probe/manifest.json`）与构建脚本产出一致。
- 谁会触发那种情况：只有"构建脚本（native/macos/scripts/build_cli.sh、prepare-probe.mjs）与启动校验不同步"这类**开发期构建缺陷**能触发；若是包篡改威胁，攻击者能改包内 manifest 就能同时改这段启动代码，自检在篡改面前不构成额外防线（原文清单与 digest 都由攻击者可重写）。
- 现有测试覆盖：desktop/tests/helpers/probe.test.mjs"仓库探针公开准备入口…"用例直接断言 prepare 输出含 20 个 buildSources、双执行文件 signingIdentifier 与 digest 格式。**注意**：该用例当前在本任务开始前已失败（6685e7d9c 上复测同样失败，`paths.syncProbePath` 为空，与 A3 无关——既有失败，已记录在 A3 提交信息与任务单 Answer）。
- 移除风险：低。这是构建产物自检而不是安全边界；保留 `buildSourceDigest` 自一致性与 `sha256` 格式检查仍能拦截"清单写错字段/摘要"的主要错误场景。删除个数与组合规则后，"新增 Swift 文件忘记同步双份清单"会从启动期阻断改为构建期/验收发现（prepare-probe 与其测试仍在）。
- 测得收益：无可测 CPU 收益（O(20) 内存正则，<0.1ms）；收益是维护性——新增 Swift 源文件不再需要同步改两处清单（本报告未实测端到端，纯静态评估）。
- 建议：**建议改**（简化为保留 `buildSourceDigest` 检查与逐项 `sha256` 格式检查，删除正则、个数与组合规则）；属应用自检策略，等用户裁决后另开任务执行。

## B2 policy-version.assertCurrent

- 位置：[backend-ts/src/memory/extraction/policy-version.ts:106](../../backend-ts/src/memory/extraction/policy-version.ts)（`sourceStamp` 捕获，`assertCurrent` 每次 `:82-112`）；调用点 `memory/sqlite/service.ts` 6 处 + 每个抽取窗口的 `requireCurrent`。
- 防什么：抽取运行期间源码 import 闭包被改动时中止，保证 `sourceStamp`/`rule_version` 与实际代码一致。
- 谁会触发：只有开发者本机改码/热更新；打包版源码不可变。
- 现有测试覆盖：backend-ts/test/extraction-policy-version.test.mjs。
- 移除风险：打包版删除无损失；开发版删除会让热更后的窗口继续用旧策略版本。折中方案（mtime+size 预检、变化才重哈希）可兼顾。
- 测得收益（本机 bench-policy.mjs，2026-11-07）：首次捕获 12.0ms、`assertCurrent` 平均 **5.1ms/次**；相对一次模型调用（秒级）占单窗 <<1%（约 0.2–0.5% 量级）。**无端到端整窗耗时实测数据**，不编造占比。
- 建议：**不改**。5ms/窗口远小于一次模型调用；除非实测占到抽取总耗时 >1%，否则不值得改。

## B3 图片字节在一次请求内多次解码/哈希

- 位置：[backend-ts/src/memory/extraction/multimodal.ts:155](../../backend-ts/src/memory/extraction/multimodal.ts)（逐图 `Buffer.from(base64)`+sha256 与期望比对）、`platform/models/model-images.ts`（digest 派生 attachment/variant 身份）、`platform/models/model-input-budget.ts`（base64 往返复检+清单 sha256 对账）。同一张图一次请求内 ≥3 次解码/哈希。
- 防什么：multimodal 防"模型未引用声明的图片/图片引用与实际文件版本不符"；model-images 派生图片身份与去重；model-input-budget 防 provider 序列化往返改变字节导致 token 预算对不上（`request_sha256` 与清单比对）。
- 谁会触发：正常多模态读完历史后向模型发图；恶意输入可放大，但量级固定。
- 现有测试覆盖：extraction-verification-envelope.test.mjs（`images_missing` 等校验）、model-input-budget.test.mjs、model-images 相关用例。
- 移除风险：中。三处摘要目的各不相同（引用核验/身份派生/对账），"让清单携带预算摘要"会跨层耦合实现细节，动它得不偿失。
- 测得收益（本机临时脚本，5MB 合成图）：base64 解码 0.597ms、sha256 1.543ms、base64 往返 0.812ms；一次请求三段合计 ≈9ms/图。窗口内图片数一般 <10，相对一次模型调用（秒级）与准备耗时 <<5%。
- 建议：**不改**。未达任务单设定的 >5% 阈值；清单对账链路不轻动。

## B4 其余自证式摘要（basis 复核与执行槽位）

- 位置：[backend-ts/src/memory/sqlite/documents/basis.ts:101](../../backend-ts/src/memory/sqlite/documents/basis.ts)（读自己存的载荷重算 `input_seal` 比对）、[backend-ts/src/memory/sqlite/execution.ts:123](../../backend-ts/src/memory/sqlite/execution.ts)（同操作槽位请求变化则 `memory_extraction_operation_changed`）。
- 防什么：`execution.ts` 槽位复验与 `input_seal` 承担**幂等重放判定**与删除标记（documents/deletion.ts:233、263 改写为 `'deleted'`，reply/sqlite/model-deletion.ts:47、55 依赖）；并发重放或槽位二次执行时改请求必被拒。`basis.ts:101` 防"读出与账面输入不一致的事件"——该库可能被旧版本写入或人工修复，读侧复核能在这种不一致下拒绝生成依据。
- 谁会触发：并发重复点击、崩溃后重试、旧版本/人工介入留下的不一致数据。
- 现有测试覆盖：sqlite-memory-documents-deletion.test.mjs、sqlite-memory-adjudication-deletion.test.mjs 等删除与重放用例。
- 移除风险：高。削弱 `input_seal` 或槽位复验会影响删除证明与幂等边界（属 C 级保护对象）；`basis.ts:101` 成本为 sha256(JSON.stringify)，亚毫秒。考虑旧版本写入与人工修复场景，读侧复核仍有真实价值。
- 测得收益：可忽略（私密路径亚毫秒级哈希，重构省不出可测收益）。
- 建议：**保留**（默认不改）。若未来开展"隔离副本库自愈/迁移实验"再单独论证此复核的必要性。

## 结论汇总

| 项 | 位置 | 结论 |
| --- | --- | --- |
| B1 | bundled-helpers validRepositoryBuild | 建议简化（保留 digest 自检查），等用户裁决 |
| B2 | policy-version assertCurrent | 不改（5.1ms/次，占单窗 <<1%） |
| B3 | 图片多次解码/哈希 | 不改（本机 5MB 图三段 ≈9ms，<<5% 阈值） |
| B4 | input_seal 复核/槽位复验 | 保留（删除证明与幂等边界，成本亚毫秒） |
