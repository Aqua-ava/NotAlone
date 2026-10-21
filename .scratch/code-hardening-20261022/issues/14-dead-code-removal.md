# 14 安全死代码删除

Triage: ready-for-agent
State: open

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
