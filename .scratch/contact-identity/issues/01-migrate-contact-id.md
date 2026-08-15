# 将 contact_id 迁移为内部稳定身份

Type: task

Triage: ready-for-agent

State: resolved

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

## Answer

已将内部联系人 UUID、微信渠道身份和展示名称分开。正式导入现在要求用户在
`ExistingContactSelection` 与 `NewContactSelection` 中明确选择：前者写入 `manual_select`，
后者在同一事务中创建联系人并写入 `manual_create`。渠道身份冲突会拒绝整批导入；消息写入
失败时，新联系人、渠道身份、来源和确认记录会一起回滚。

验证命令：

```bash
NOTALONE_TEST_DATABASE_URL=postgresql:///notalone_identity_test \
  conda run -n NotAlone python -m unittest discover -s tests -v
```

结果为 52 项测试全部通过。测试仅使用合成夹具，没有读取或导入 `chat_exports/` 中的真实资料。

## Comments

- 2026-08-16：完成首个 TDD 切片。正式导入现在要求选择既有内部联系人 UUID，并在同一
  事务中写入微信渠道身份、`manual_select` 确认、来源和消息；重复绑定或静默改绑会拒绝。
  使用隔离数据库 `notalone_identity_test` 和合成夹具运行 47 项测试全部通过。尚未实现
  首次导入时创建新联系人（`manual_create`），因此任务继续保持 `claimed`。
