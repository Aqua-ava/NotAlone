# 05 原因码拆分、界面口径、规格与 ADR-174

Triage: ready-for-human
State: resolved
Blocked by: 01, 02, 03

按 spec.md 第 7 节实施。

- `memory_relation_pending` 拆成 `memory_relation_conflict`、`memory_relation_evidence_incomplete`、`memory_relation_unsupported`、`memory_relation_inconsistent`；同步 reason 赋值、前端文案映射、依赖原因码的测试；旧数据中的原因码不迁移，未知码走兜底文案。
- 界面口径：未裁决且无拦截条件的候选标「处理中/未完成」而不是「待确认」；触发处理使用现有「继续 / 放弃未知并重试」入口。
- 新增 ADR-174、修改 memory-processing.md、规格状态在验收后更新。

## Answer（2026-11-06）

已完成并本地提交（fefa2e75c）。

- 后端：`adjudication-actions.ts` 原因码拆分落地（动作与关系不符归 inconsistent）；冻结门槛失败时在提取 attempt 写 `memory_conditions_pending` 留痕；`read.ts` `pendingDerivation` 按最近裁决结果与两处留痕把 pending 候选派生为 `decision_pending`（真待确认）或 `processing_incomplete`（处理未完成），不改表；`pendingStage/pendingReason` 进入 `MemoryCandidateView`（归档原稿快照不含该时效字段）。
- 桌面（仅 hunk 级提交本任务改动）：主进程校验透传新字段；记忆页拆「待确认记忆」与「处理中/未完成」分栏，候选卡显示原因码固定文案，未知码兜底；未完成组不提供采纳入口并在卡内说明用处理页继续/重试。
- 文档：新增 `architecture/adr/174-align-tencent-uncertainty-degrade-not-intercept.md`（已采纳，含被替代规则、残留风险、回退方式，ADR README 已加索引）；`memory-processing.md` 第 1 条补 uncertainty 降级与 low_value_dropped、第 3 条收窄为白名单原因码并补 independent 覆盖/keep/noop 自动条件。
- 与 spec 6.草案的偏差（依测试为准）：spec 6.3「受保护/撤回目标不适用 noop」与既有验收（candidate-admission 同源重复场景先保护/撤回仍期望 noop 消费）冲突——auto_noop 不改写记忆内容，保护语义由版本闭包维持，故不在 noop 上按保护状态拦截；已在 ADR-174 记录语义。

验证：
- 后端 `npm run typecheck` 通过；desktop `npm run typecheck` 通过。
- 后端相关套件：证据/裁决×4/verified-results/auto-switch/auto-profile/content-upgrade 共 67 用例全绿；candidate-admission+candidate-history 25/28（3 条跨文件偶发为基线已存在的存量问题，单文件运行全绿）。
- 桌面管理视图 37/37（含新增「候选按处理状态分组」用例：待确认知性行原因文案，未完成组无采纳入口）。

桌面运行验收（`pnpm run dev` 热更新实例 + Computer Use）在任务 06 的验收轮中一并执行。

## Comments

- 提交时工作树含上一个任务未提交的面板改动（分页按钮文案），按 hunk 拆分仅提交本任务改动，原改动保持未提交状态待其任务收尾。
