# 解除规范消息对微信字段的强制依赖

Type: task

Triage: ready-for-agent

State: open

## Problem

`NormalizedMessage` 和 `message` 表当前强制要求微信 local/server id、talker 和完整原始 JSON，OCR、语音转写或手工文字无法使用同一规范消息契约。

## Acceptance criteria

- 规范消息只要求隔离键、说话人、正文或媒体占位信息、可用时间戳和来源定位。
- 微信专属字段保存在来源或适配器元数据中，不成为其他输入类型的必填字段。
- 原始 JSON 不进入回复检索或模型载荷，并能随来源删除。
- 单元测试覆盖无时间戳文字、媒体占位、空记录拒绝和微信 JSONL 兼容行为。

## Comments
