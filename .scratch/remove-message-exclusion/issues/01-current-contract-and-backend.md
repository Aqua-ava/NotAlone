# 当前 SQLite 工作区合同与后端移除排除消息

Triage: ready-for-agent
State: resolved

规格：[删除逐条消息选择与排除功能](../spec.md)。

## 目标

移除当前 SQLite 候选工作区中的 `excludedMessageIds`／`excluded_message_ids`，让关系背景开启时始终使用最近最多 50 条；关系背景关闭时不带自动背景。旧字段作为新请求输入必须被拒绝。

## 范围

- 更新工作区类型、校验、指纹版本和请求解析。
- 移除后端最近消息过滤、派生资料停用和来源联系人集合中的排除分支。
- 更新当前 SQLite 后端测试，先红后绿。
- 不修改旧桌面回复链路；由 03 处理。

## 测试 Seam

公开边界：当前 SQLite 候选工作区 HTTP 合同与生成请求。

1. 新工作区无排除字段时接受，并自动纳入最近 50 条。
2. 新工作区携带旧字段时拒绝，不创建请求、不调用模型。
3. 关系背景关闭时最近消息为 0；开启时恢复 50 条，不按排除数组过滤。
4. 关系资料与携入候选不再因排除数组停用。

## 验收

- 当前 SQLite 合同和测试通过。
- 没有新请求产生排除字段；旧字段不会静默忽略。

## Comments

- 2026-11-04：按用户要求仅发布实现 ticket，不开始代码实现。

## Answer

- 实现：SQLite 工作区合同删除 `excludedMessageIds`，只接受 action、草稿、语气、一次性要求、补充背景和关系背景开关；工作区指纹升为 `version: 2`。HTTP 与工作区解析对 `excludedMessageIds`／`excluded_message_ids` 均按 `reply_input_invalid` 拒绝，不创建请求。
- 行为：关系背景开启时按消息时间自动冻结当前联系人最近 50 条，不再按排除集合过滤；关闭时不带自动聊天和派生资料。携入选稿只受关系背景开关约束，不再因排除数组被额外禁用。测试适配仅移除已退役字段，未改变联系人、来源、预算、删除或失败语义。
- 验证：`cd backend-ts && node --test test/sqlite-reply-workspace-exclusion-contract.test.mjs test/sqlite-reply-candidate-input-regressions.test.mjs test/sqlite-reply-candidates.test.mjs test/sqlite-reply-bounded-knowledge.test.mjs test/sqlite-reply-source-recovery.test.mjs` → 42 pass / 0 fail；`node node_modules/typescript/bin/tsc --noEmit` → exit 0；`node scripts/check_public_history.mjs --ref HEAD --working-tree` → issues 0。
- 状态：实现与最小后端验证完成；当时 State 保持 `claimed`，等待独立 Standards／Spec 审查与桌面票收口；最终状态为 `resolved`。桌面 UI 与旧桌面链路分别由 02、03 完成。
