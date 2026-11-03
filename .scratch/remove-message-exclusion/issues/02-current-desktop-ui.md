# 当前 SQLite 表达工作区移除逐条消息选择

Triage: ready-for-agent
State: open
Blocked by: 01

规格：[删除逐条消息选择与排除功能](../spec.md)。

## 目标

当前 SQLite 表达工作区保留最近聊天查看和刷新，但消息列表只读；移除逐条 checkbox、排除提示和排除状态相关请求字段。

## 范围

- `SqliteReplyCandidatesPanel` 默认值、生成参数、刷新和继续候选逻辑。
- `sqlite-reply-candidates` 共享类型与操作校验。
- 当前 SQLite 桌面测试、类型检查。
- 关系背景总开关和最近聊天查看入口保留。

## 测试 Seam

公开边界：桌面表达工作区渲染与候选 bridge 请求。

1. 最近聊天加载后没有逐条消息 checkbox。
2. 生成请求的 workspace 不含 `excludedMessageIds`。
3. 关系背景关闭时最近聊天不带入，开启时自动带入。
4. 候选继续不再因排除数组被禁用。

## 验收

- 当前窗口不再显示消息级勾选或排除提示。
- 刷新最近聊天和关系背景开关仍可用。
- 相关桌面测试和类型检查通过。

## Comments

- 2026-11-04：按用户要求仅发布实现 ticket，不开始代码实现。
