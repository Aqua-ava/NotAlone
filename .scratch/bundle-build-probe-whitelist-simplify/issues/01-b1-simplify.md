# B1 简化：validRepositoryBuild 保留摘要校验、去掉白名单与组合规则

Triage: ready-for-agent
State: resolved
Type: task

Blocked by: none

先读 [spec.md](../spec.md) 全文与 [B 级分析报告 §B1](../../docs/verification/self-verification-review-20261106.md)，再开始。

## Goal

按 spec 执行：`validRepositoryBuild` 只保留摘要自一致性与 sha256 格式检查；正则白名单、个数区间、组合规则、最小布局公式删除。任何已存在测试的期望按新行为更新（这是行为变化，不是"修测试让它过"），并在 Answer 写明每处期望更新的理由。

## 验收

- [ ] 新清单（20 个 buildSources 的现有产物形态）校验仍通过；对"缺一类文件、多一个文件、改名"的新行为（不因白名单拒绝）有测试锁定。
- [ ] 对摘要被改、sha256 非法的清单仍拒绝（原有行为不变）。
- [ ] `prepare-probe.mjs` 重新产出的完整清单经 `validRepositoryBuild` 通过（或该入口与既有失败的关系已说明）。
- [ ] 既有失败 `probe.test.mjs` 与本任务的关系在 Answer 里明确（不混修）。
- [ ] desktop `npm run typecheck` 与相关测试全绿；提交一个主题；rules/边界满足 spec。

## Test seam

`resolveSyncProbePath`／`resolveHeaderChangeSourcePath` 的公开解析结果（注入 `execute`）；`validRepositoryBuild` 经 manifest 注入直接调用。

## 停止条件

- 发现组合规则实际承担"包完整性"以外的运行时破绽（如实记录并停下问用户）。
- 需要改 native/macos 构建脚本本体。

## Answer

改动（提交内 3 个仓库文件）：
- `desktop/src/main/backend/bundled-helpers.ts#validRepositoryBuild`：
  - **保留**：`buildSourceDigest` sha256 格式检查、`sourceDeclaration === "repository:"+buildSourceDigest` 组成检查、`buildSources` 必为数组、逐项对象形状与 `record.sha256` 格式（`/^[a-f0-9]{64}$/`）检查、末尾自一致性 `sha256(JSON.stringify(buildSources)) === buildSourceDigest`。`files` 摘要/字节校验、codesign 核验、A3 按资源目录缓存、`resolveSyncProbePath` 配置分支均未动。
  - **删除**：Swift 源文件名正则白名单、允许个数区间 `[8,9,11,…,20]`、「存在 A 则 B 必须存在」组合规则组（8 条）、最小布局个数公式；及其唯一服务对象——`names` 集合与 `record.name` 类型/去重判断（新规则下源名无任何下游消费，仅作为摘要载荷参与 self-digest）。未发现组合规则承担包完整性以外的运行时职责，未触发停止条件。
- 新增 `desktop/tests/helpers/probe-manifest-simplify.test.mjs`（已登记 `tests/inventory.json` safe-node）：一次真实 `prepareRepositoryProbe` 产物做基线，逐案复制到独立 temp 且每案新起 runner 进程（注入 `testCodesignExecutor` 假 codesign，规避 A3 同进程按目录记忆），覆盖：真实清单通过、包内默认配置路径经整组核验通过、资源外配置路径原样透传、**删组合规则成员 RegionCalibration+重算摘要通过**、**白名单外新增 Swift 源+重算通过**、**改名+重算通过**、摘要改错值（digest 与声明同改）拒绝、单源 sha256 格式非法（重算摘要、仅命中保留项）拒绝、buildSourceDigest 格式非法拒绝。
- `desktop/tests/helpers/probe.test.mjs` 未改：其 :153–177 清单篡改期望因既有失败（:88 先行断言失败）不可达；覆盖关系映射到新测试的逐案用例（未知源/删成员/改名→通过；摘要自一致、sha256/digest 格式→拒绝）。

既有失败对照：`node --test tests/helpers/probe.test.mjs` 前后均为 4 测试 3 过 1 失败，唯一失败同一用例、同一断言（tests/helpers/probe.test.mjs:88，`paths.syncProbePath` 期望探针路径、实际 `''`，prepare 本身 status 0）——本任务不修复也不混改。

验证：`node --test tests/helpers/probe-manifest-simplify.test.mjs` 全绿（约 37 s，含一次真实构建签名，不执行探针、不启动 App）；与 `tests/header-change-source-process.test.mjs`、`tests/header-change-diagnostics.test.mjs` 联跑 17/17 通过；`npm run typecheck` 通过。

补充定位（未入本任务）：在正确 resources 根（含 notalone-probe 的目录）下，用逐检查点脚本复刻验证，真实 codesign 与假 codesign 对新 prepare 产物均为完整通过——即新/旧 validRepositoryBuild 都接受真实清单，既有失败出在更高层启动装配（diagnostics/配置）路径，与本缝隙无关。另：`validateTestInventory` 对当前树会先报 `tests/helpers/runtime-cache.test.mjs` 未登记，经 HEAD 核对该不一致在任务前已存在，非本次引入，未顺手登记；`.scratch/read-goal-empty-probe-loop` 的并行改动（docs 草稿与 fixtures）为本任务期间出现，已按要求如实报告。

## Comments
