# 解除规范消息对微信字段的强制依赖

Type: task

Triage: ready-for-agent

State: resolved

## Problem

`NormalizedMessage` 和 `message` 表当前强制要求微信 local/server id、talker 和完整原始 JSON，OCR、语音转写或手工文字无法使用同一规范消息契约。

## Resolved design

`NormalizedMessage` 作为跨输入类型的通用 Interface，只包含来源定位、说话人、消息类型、
正文、可选媒体占位和可选发生时间。微信导入器额外产生可选的
`WechatMessageMetadata`，保存 local/server id、talker、来源时间和原始 JSON；其他输入适配器
不需要伪造这些字段。

PostgreSQL adapter 把通用字段写入 `message`，把微信字段写入一对一的
`wechat_message_metadata`。元数据表冗余 `owner_id + contact_id + source_document_id` 并使用
复合外键证明归属，同时继续用微信 local id 保证同一联系人下不跨来源重叠。来源删除时，两表
通过外键一起级联删除。

TDD 只从三个已确认 seam 观察行为：`NormalizedMessage` 构造契约、
`normalize_document(...) -> ImportBatch` 的微信兼容结果，以及
`IngestRepository.import_document(...) -> ImportResult` 加 PostgreSQL schema 约束。测试不读取
真实资料，也不引入 OCR、语音或检索实现。

## Acceptance criteria

- 规范消息只要求隔离键、说话人、正文或媒体占位信息、可用时间戳和来源定位。
- 微信专属字段保存在来源或适配器元数据中，不成为其他输入类型的必填字段。
- 原始 JSON 不进入回复检索或模型载荷，并能随来源删除。
- 单元测试覆盖无时间戳文字、媒体占位、空记录拒绝和微信 JSONL 兼容行为。

## Answer

`NormalizedMessage` 已解除对微信字段和时间戳的强制依赖，并新增明确的媒体占位字段；正文和
媒体占位不能同时为空。微信 JSONL adapter 继续兼容现有格式，但把 local/server id、talker、
来源时间和原始 JSON 封装为可选 `WechatMessageMetadata`。

迁移 `004_separate_wechat_message_metadata.sql` 把微信字段搬入独立
`wechat_message_metadata` 表。通用 `message` 使用 `source_locator` 定位来源片段；微信 local
id 的跨来源重叠约束保留在元数据表。来源删除时，消息和微信元数据通过外键一起级联删除。

验证包括：

```bash
NOTALONE_TEST_DATABASE_URL=postgresql:///notalone_identity_test \
  conda run -n NotAlone python -m unittest discover -s tests -v
```

结果为 57 项测试全部通过。另在 `notalone_message_migration_test` 中使用 1 条合成旧版消息验证
非空迁移：通用消息与微信元数据均保留 1 条、旧列为 0，事务内删除来源后两表均为 0，回滚后
恢复为各 1 条。没有读取或导入 `chat_exports/` 中的真实资料。

## Comments
