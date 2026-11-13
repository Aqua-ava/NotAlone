# 05 删除桌面未接线代码

Triage: ready-for-agent
State: resolved

## 目标

删除桌面生产 0 import 的未接线代码，并同步删除/迁移仅测试引用的用例，避免丢真实覆盖。

## 证据

`.scratch/code-audit-20261022/verify-unused.md`「需决策」「低风险」两节；Lead 已核实 calibration 集群源码无外部 import。

## 范围

- `desktop/src/main/foreground/calibration.ts`(183)、`calibration-form.ts`(80)、`calibration-profile.ts`(223)、`calibration-selection.ts`(47)：删除；同步清理仅引用它们的 `desktop/tests/helpers/calibration-progress.test.mjs` 等。
- `desktop/src/renderer/StrategyControls.tsx`(110)、`ReplySceneInput.tsx`(17)：生产 0 import 且仅测试打包；删除组件与对应测试断言（或把测试改为等价的最小 fixture，二选一并说明理由）。
- 删除后确认没有 esbuild/build 入口仍引用这些路径（检查 `desktop/scripts`、`desktop/tests`、`test-inventory`）。

## 验收

- `cd desktop && npm run typecheck` 通过。
- `cd desktop && npm test` 通过（安全集，报告项数与跳过）。
- `node scripts/test-inventory.mjs` 通过。
- 报告删除行数与测试覆盖变化。

## Comments

- 2026-10-22 desktop-cleaner：已认领并实现（State: claimed → resolved）。
- 删除源码 660 行：`main/foreground/calibration.ts`(183)、`calibration-form.ts`(80)、`calibration-profile.ts`(223)、`calibration-selection.ts`(47)、`renderer/StrategyControls.tsx`(109)、`renderer/ReplySceneInput.tsx`(16)。
- 同步删除测试 392 行：`tests/helpers/calibration-progress.test.mjs`(331，仅覆盖已删 calibration-profile)、`tests/reply-strategy-display.test.mjs`(61，仅覆盖生产 0 import 的 StrategyControls)。
- 迁移而非删除：`tests/real-foreground-credential.ts` 原依赖已删的 `calibration-selection.validatedSelection`，改为测试侧等价 `assertFrozenSelection`（冻结 profile 结构校验原样保留，避免丢真实前台验收覆盖）；`tests/skill-learning/view.test.mjs` 移除 ReplySceneInput 单一组件渲染用例；`tests/fixtures/assistant-budget-public.mjs` 去掉 StrategyControls 导出与 renderStrategy，`tests/assistant-provider-context-public.test.mjs` 去掉 2 条死组件渲染断言（HTTP 行为断言保留）。
- 回归护栏：`tests/dead-code-removal.test.mjs` 登记 8 个已删文件与 3 个已删组件名，并新增「构建/测试入口不引用已删代码」用例；`tests/inventory.json` 移除 2 个已删测试。
- 验证：`cd desktop && npm run typecheck` 通过；`node scripts/test-inventory.mjs` 通过（safe-node 123/headless 17/isolated-http-pg 57/native 9/app 67）；`npm test` → 972 tests，971 pass / 1 skipped / 0 fail；`node --test tests/dead-code-removal.test.mjs tests/real-foreground-credential.test.mjs` → 21 tests，20 pass / 1 skipped；`node --check` 校验 3 个改动测试与夹具语法通过。
- 引用复核：`src tests scripts` 内除护栏测试自身外零引用；`scripts/build.mjs` 入口只有 `src/main/index.ts`/`src/preload/index.ts` + Vite renderer root，无被删路径。
- 剩余风险：`research/notalone-input-prediction-feasibility-20261015.md:27` 仍链接已删的 `StrategyControls.tsx`（研究文档，不在本轮写权限内，建议 Lead 决定是否补一句「已删除」）；`desktop/artifacts/**` 历史构建证据里的 calibration 路径仅为归档记录，未改。
