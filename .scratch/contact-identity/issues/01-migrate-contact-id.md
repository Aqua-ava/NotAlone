# 将 contact_id 迁移为内部稳定身份

Type: task

Triage: needs-info

State: open

## Problem

`ContactPreview.contact_id`、`contact.id` 和消息的 `contact_id` 当前直接使用微信 `sender_wxid`，与 ADR-008 冲突。

## Required decision

在实施前确定内部 `contact_id` 的具体编码，以及现有数据库中已导入数据的迁移与回滚策略。不得从微信导出文件读取 `owner_id`。

## Acceptance criteria

- 内部联系人身份、微信渠道身份和展示名称使用不同字段表达。
- 首次导入支持创建或选择联系人，并保存最小确认记录。
- 新来源与已确认渠道身份不一致时停止导入，不静默改绑。
- 迁移、回滚、幂等和联系人隔离使用合成数据验证。

## Comments
