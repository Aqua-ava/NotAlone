# 实现来源级删除与不可检索验证

Type: task

Triage: ready-for-agent

State: resolved

## Problem

数据库允许来源进入 `deleted`，但当前代码没有保证关联消息和派生资料已经删除，也没有不可检索验证。

## Resolved design

删除模块提供一个深 Interface：

```text
delete_source(owner_id, contact_id, source_document_id) -> SourceDeletionResult
```

PostgreSQL adapter 在 Interface 内完成 `delete_requested -> deleting -> deleted` 状态迁移，删除
当前已实现的 `message`、`wechat_message_metadata` 和 `import_confirmation`，并在写入
`deleted` 前确定性验证这些记录均不可检索。失败时单独写入 `delete_failed`，不得保留
`deleted` 假象；重复删除返回原删除凭证。

`source_document` 在删除完成后只保留 owner/contact/source 内部 ID、来源类型、删除状态和时间；
文件名、SHA 和记录数被清空。同一文件再次导入时生成新的来源与确认记录，不复用旧来源。
后台 Worker 和用户界面仍不在本任务范围；该 Interface 可由未来删除 Worker 调用。

TDD seam 为 `delete_source(...) -> SourceDeletionResult` 和 PostgreSQL schema 约束。集成测试使用
合成数据验证成功、幂等、失败状态、隔离、不可检索和重新导入，不读取真实资料。

## Acceptance criteria

- 删除请求、执行中、失败和删除完成使用不同状态。
- 只有关联消息及当前已实现的派生数据清除后，来源才能进入 `deleted`。
- 删除操作幂等；失败不留下看似完成的状态。
- 集成测试证明删除后按 `owner_id + contact_id`、来源 ID 和消息 ID 均无法检索对应内容。
- 再次导入同一文件时重新预览、确认并创建新来源，不恢复旧来源内容。

## Answer

已新增 `PostgresSourceDeletionRepository.delete_source(...)`。它按 owner、contact 和来源 ID
锁定删除范围，记录删除状态，清除当前已实现的消息、微信原始元数据和导入确认记录，执行
零记录验证后才写入脱敏的 `deleted` 凭证。重复删除返回 `already_deleted`；错误只记录
`storage_delete_failed`，原消息事务回滚并保持可重试。

迁移 `005_source_deletion_state.sql` 增加独立状态和数据库约束。`deleted` 来源必须清空文件名、
SHA 和记录数并带删除时间；只修改状态会被数据库拒绝。删除后重新导入同一合成文件会产生新的
来源 ID、确认记录和消息，不恢复旧来源。

验证命令：

```bash
NOTALONE_TEST_DATABASE_URL=postgresql:///notalone_identity_test \
  conda run -n NotAlone python -m unittest discover -s tests -v
```

共 62 项测试全部通过，覆盖成功删除、按来源/联系人/消息 ID 不可检索、失败回滚、幂等、
联系人隔离和重新导入。测试只使用合成夹具，没有读取或导入 `chat_exports/` 中的真实资料。
后台 Worker、UI、索引和
尚未实现的派生资料删除不在本任务范围。

## Comments
