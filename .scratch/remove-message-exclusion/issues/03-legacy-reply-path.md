# 旧桌面回复链路移除排除字段与勾选

Triage: ready-for-agent
State: open
Blocked by: 01

规格：[删除逐条消息选择与排除功能](../spec.md)。

## 目标

旧 `RewriteSnapshot`／会话链路不得再发送或渲染消息排除字段。历史载荷中的旧字段必须被明确拒绝，不能静默转成空数组。

## 范围

- `desktop/src/shared/reply-bridge.ts`。
- `desktop/src/main/reply/bridge.ts`、`client.ts`、`pasted-input.ts`、`session.ts`。
- `UnifiedReplyWorkspace`、`ReplyGenerationGuidance`。
- 相关桌面测试。

## 测试 Seam

公开边界：旧桌面回复输入合同、历史恢复和统一工作区渲染。

1. 设置更新和生成请求不接受排除字段。
2. 历史载荷含 `excluded_message_ids` 时拒绝恢复，不创建请求。
3. 统一工作区没有消息级 checkbox 或排除提示。
4. 旧候选回看仍可用。

## 验收

- 旧链路与新链路一致，不再产生排除状态。
- 历史排除载荷不会被静默扩大资料范围。
- 相关测试和类型检查通过。

## Comments

- 2026-11-04：按用户要求仅发布实现 ticket，不开始代码实现。
