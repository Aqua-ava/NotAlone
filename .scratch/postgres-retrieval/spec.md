# PostgreSQL 消息检索

Type: task
State: resolved
Triage: ready-for-agent
Implementation: completed; 已实现 RetrievalPort 的消息查询，不处理关系记忆落库

## Scope

为 `RetrievalPort.search_messages` 增加 PostgreSQL 只读适配器。适配器接收已经确认的
`ContactScope`，先按 `owner_id + contact_id` 过滤，再按可选关键词和数量限制返回
`RetrievedMessage`。查询只读取规范化 `message` 与其 `source_document` 状态，不读取
微信原始来源元数据，也不修改任何数据。

## Contract

- 只返回当前联系人范围内、来源状态为 `active` 的消息。
- 多个关键词按空白分隔，必须全部出现在消息文字或媒体占位中；匹配大小写不敏感。
- `target_message_id` 存在时，目标消息先返回；目标消息不受关键词过滤，但仍必须属于当前范围且来源有效。
- 结果按消息发生时间倒序排列；无时间的消息排在有时间消息之后，并用稳定 ID 打破并列。
- 文字为空时使用 `media_placeholder` 作为统一检索/生成文本表示。
- 数据库异常转换为不泄露 SQL、连接信息或聊天正文的稳定 Retrieval 错误。
- 本任务不实现 `search_confirmed_memories` 的查询逻辑，只保留显式 fail-closed 边界；不新增
  `confirmed_memory` 表或关系记忆生命周期。

## Verification

- PostgreSQL 集成测试覆盖联系人与 owner 隔离、来源状态过滤、关键词、limit、目标消息置顶和媒体占位。
- 通过项目单元测试、PostgreSQL 集成测试、`compileall` 与 `git diff --check`。

## Answer

已完成 PostgreSQL 消息检索的只读适配器 `PostgresRetrieval`：

1. `search_messages` 先按 `owner_id + contact_id` 和 `source_document.status = 'active'`
   过滤，再执行大小写不敏感的多关键词匹配和 limit；目标消息会在同一范围内先返回。
2. 结果按 `occurred_at DESC NULLS LAST, id DESC` 稳定排序；纯媒体消息使用
   `media_placeholder` 作为统一检索文字，并保留 `source_document_id` 证据引用。
3. PostgreSQL 事务使用 `REPEATABLE READ, READ ONLY`；数据库异常和结果结构异常转换为
   不泄露 SQL、连接信息或聊天正文的稳定 Retrieval 错误。
4. `search_confirmed_memories` 在 Memory schema 尚未建立前显式 fail closed，不静默返回空记忆，
   因而本任务没有新增 `confirmed_memory` 表或 Memory 生命周期。

验证结果：`notalone_conversation_test`（001-008 迁移）上的 integration 55/55、unit 97/97
通过；`compileall`、`git diff --check` 通过；测试后 `owner`、`contact`、`source_document`、
`message` 均为 0 行。默认 `notalone_test` 全量仍是 123 个测试中的 3 个既有失败、22 个旧
schema 错误和 5 个跳过，原因是该库未应用现行 003-008 迁移；本任务测试在旧 schema 上正确跳过。
