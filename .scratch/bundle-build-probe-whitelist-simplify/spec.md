# 桌面端构建探针清单自检的简化

Triage: ready-for-agent
State: open

> 来源：任务 04 B 级报告（`docs/verification/self-verification-review-20261106.md` §B1，提交 `26fa0fde4`）与用户 2026-11-07 裁决："另开 B1 简化小任务（保留摘要校验，去掉白名单与组合规则）"。
> 前置阅读：该报告 §B1 的威胁模型结论（这是构建期自检而不是安全边界：能改包的攻击者可以同改启动代码，正则/个数/组合规则拦不住篡改，只拦"构建脚本与校验不同步"）。

## Goal

简化 `desktop/src/main/backend/bundled-helpers.ts` 的 `validRepositoryBuild`（A3 后约 :111–141；调用点 :80）：

- **保留**：`buildSourceDigest === sha256(JSON.stringify(buildSources))` 的清单摘要自一致性检查、逐个源文件的 sha256 格式检查、现有 `codesign` 核验（不属于本任务）。
- **删除**：Swift 源文件名正则白名单、允许文件个数（`[8,9,11,12,…,20]` 区间）、"存在 A 则必须存在 B"组合规则、最小布局个数公式。
- 动机：新增 Swift 源文件不再需要同时改两处清单；whitelist/组合规则在威胁模型下无增量价值。

## 边界

1. 不改 `codesign` 相关核验、不改 A3 的资源目录缓存语义、不改 `resolveSyncProbePath` 的配置路径分支行为（`bundled-helpers.ts` 上部）。
2. 只动 `desktop/`（`bundled-helpers.ts` + 测试 + 如有 prepare-probe 的测试）；不动 `backend-ts/src`。
3. 已知既有失败：`desktop/tests/helpers/probe.test.mjs` "仓库探针公开准备入口…" 用例在任务 04 之前就失败（`paths.syncProbePath` 为空；见 04 任务单 Answer）——与本任务无关，本任务的测试运行须把该既有失败与本次行为改动区分开；如顺手修复确有把握，单独一个提交。否则不动它。
4. 验证阶梯：先 `cd desktop && node --test tests/helpers/probe.test.mjs`（隔离出既有失败）→ `tests/header-change-source-process.test.mjs`、`tests/header-change-diagnostics.test.mjs`、`npm run typecheck`。
5. 行为验证：用 `native/macos/scripts/build_cli.sh`／`prepare-probe.mjs` 正常产出一遍探针并断言 `validRepositoryBuild` 通过；再对一个故意缺一类"组合规则成员"文件号的清单（原规则会拒）断言新逻辑仍通过、对故意改坏摘要/摘要格式仍拒绝。
6. 提交一个主题（或"简化"与"既有失败修复"两个主题分开）；`git add <精确路径>`、标题中文、正文 1、2、3、4、**无署名行**、不 push；提交后跑 `node scripts/check_public_history.mjs --ref HEAD --working-tree`。

## 不在范围

- 桌面端其余 hash 封装（A1 边界划定不动）；`backend-ts` 任何文件。
- 重新设计探针构建管线本身。

## Answer

（执行 Agent 填写：删除的检查项保留的检查项、前后测试差异、新增防坏用例、既有失败的处理、验证命令。）

## Comments
