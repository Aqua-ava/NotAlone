# 将 contact_id 迁移为内部稳定身份

Type: task

Triage: ready-for-agent

State: open

## Problem

`ContactPreview.contact_id`、`contact.id` 和消息的 `contact_id` 当前直接使用微信 `sender_wxid`，与 ADR-008 冲突。

## Resolved design

内部 `contact_id` 使用 NotAlone 生成的 UUID。当前没有真实数据入库，因此迁移只允许在不存在
旧 `contact`、`source_document` 和 `message` 的数据库执行；发现旧数据即失败，不静默把
`sender_wxid` 认作已确认的内部联系人。失败由迁移事务回滚；迁移成功并产生新格式数据后，
回退依赖迁移前备份，不提供有损反向 SQL。完整 Interface、事务和测试 seam 见上级
`spec.md`。

## Acceptance criteria

- 内部联系人身份、微信渠道身份和展示名称使用不同字段表达。
- 首次导入支持创建或选择联系人，并保存最小确认记录。
- 新来源与已确认渠道身份不一致时停止导入，不静默改绑。
- 迁移、回滚、幂等和联系人隔离使用合成数据验证。

## Comments
