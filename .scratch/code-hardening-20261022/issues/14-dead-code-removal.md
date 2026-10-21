# 14 安全死代码删除

Triage: ready-for-agent
State: resolved

## 目标

删除复核确认的安全死代码，并同步测试；不动任何需产品/架构决策的对象。

## 证据

- `backend/src/notalone/reply/adapters/constraint_review_contract.py:87 REVIEW_TOOL`：全仓仅定义处，与动态构建不一致。
- 桌面死组件/死导出约 137 行：`RewritePanel.tsx:130-155` 的 ReplyModePicker/ReplySourcePicker（连测试 0 引用）、`RewritePanel.tsx:157-196` RewriteInput（仅 2 测试）、`DirectedReplyInput.tsx`(45)、`ProactiveReplyInput.tsx`(27)。
- 复核：`verify-unused.md` A6/A8、B8。

## 范围

- 上述删除 + 对应测试清理；grep 确认无生产/测试残留 import。
- **不删**：`fidelity_evaluation`、`recall_cases/evaluation`、evaluation_*、experiments、`contact_deletion.py`、`index.ts:149` 的 catch、schema 探针——均见复核「不要误删」清单。
- 不改公共导出面之外的行为。

## 验收

- 后端相关单测；`cd desktop && npm run typecheck` + 受影响 node tests；报告删除行数与零引用证据。

## Comments

## Comments

- 删除（复核确认零引用）：`constraint_review_contract.py` 的固定三候选常量 `REVIEW_TOOL = build_review_tool(3)` 与随附空行（保留按候选数动态构建的 `build_review_tool`）；`RewritePanel.tsx` 的 `ReplyModePicker`/`ReplySourcePicker`/`RewriteInput` 三个死导出（398→327 行）；`DirectedReplyInput.tsx`(45 行)、`ProactiveReplyInput.tsx`(27 行) 整文件；对应测试 `tests/rewrite-generation-entry.test.mjs`(39 行) 删除，`desktop-interaction-view.test.mjs` 删除仅测试 RewriteInput 的双窗口段落，`skill-learning/view.test.mjs` 删除仅测试 ProactiveReplyInput 的段落；顺手清理上述文件因此失效的 import。
- 零引用证据：`grep -rn 'ReplyModePicker|ReplySourcePicker|RewriteInput|DirectedReplyInput|ProactiveReplyInput|REVIEW_TOOL'` 在 desktop/src、desktop/tests、backend/src、backend/tests、docs、README.md 均为 0（守卫测试自身除外）；生产入口只有 `UnifiedReplyWorkspace` 等现存组件。
- 未删除 ticket 列出的「需决策」对象：fidelity_evaluation、recall_cases/recall_evaluation、evaluation_*、experiments、contact_deletion.py、index.ts:149 的 catch、schema 探针，以及已实现待接线的记忆 UI。
- 测试：新增 `tests/dead-code-removal.test.mjs`（删除前红：残留组件/引用/固定常量；删除后 3/3 绿）；`tests/skill-learning/view.test.mjs` + `tabs.test.mjs` 共 13/13；`npm run typecheck` 通过；`npm run test:inventory` 通过；后端 `tests.unit.reply.test_constraint_review_sdk/test_review_unit_ranges/test_shared_review_claims/test_fidelity_review_details` 52 项 OK。
- 数据影响：纯代码/测试删除，无行为与数据结构变更；未做真实 App 验收。
