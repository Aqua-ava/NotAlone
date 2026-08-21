# PostgreSQL Memory

Type: task
State: resolved
Triage: ready-for-agent
Implementation: completed; 已实现 MemoryPort 持久化和已确认记忆检索，不实现记忆目录与自动提取

## Scope

为当前 `MemoryPort` 增加 PostgreSQL 适配器，持久化 `memory_candidate`、
`confirmed_memory` 及其联系人范围、来源 UUID 列表、候选来源链、状态、有效期和修订号。
`PostgresRetrieval.search_confirmed_memories` 通过同一数据库读取当前联系人范围内可检索的
已确认记忆。

本切片沿用现有领域模型的 `source_ids: tuple[UUID, ...]`，在数据库中保存为 `uuid[]`；不
预先增加消息 span、session_capture 类型或新的来源本体。

## Contract

- 所有候选和记忆读写都先校验 `owner_id + contact_id`。
- 候选来源 UUID 必须属于同一联系人范围且当前 active；来源失效后已确认记忆不再检索。
- 候选状态支持 pending、confirmed、rejected、invalidated；只有 pending 可以确认、拒绝或失效。
- 确认在同一事务中把候选标为 confirmed 并创建已确认记忆；重复确认重放原记忆。
- 修正只允许 active 记忆，递增 revision；invalidate/delete 都使记忆不再进入检索。
- 检索只返回 active、当前有效且至少仍有一个 active 来源引用的已确认记忆。
- 数据库错误不泄露 SQL、连接信息、聊天正文或记忆正文。
- 本切片不实现 `contact_memory_index`、memory_revision、自动提取、extract_failed 工作流、来源删除任务级联和 UI。

## Verification

- PostgreSQL 集成测试覆盖确认前不可检索、确认幂等、修正/失效/删除、候选拒绝/失效、范围隔离、来源失效和数据库错误。
- 通过项目 unit、integration、compileall 与 diff 检查；测试只使用匿名合成 owner/contact/source。

## Answer

已完成 PostgreSQL Memory 的第一个持久化切片：

1. 新增 `database/migrations/009_memory_store.sql`，建立 `memory_candidate` 和
   `confirmed_memory`，保存联系人范围、分类、`uuid[]` 来源、候选来源链、采纳方式、状态、
   有效期和 revision。
2. 新增 `PostgresMemoryStore`，覆盖候选创建、确认幂等、修正、拒绝、候选失效、记忆失效、
   删除和范围校验；写入候选前确认来源属于同一联系人且 active。
3. `PostgresRetrieval.search_confirmed_memories` 已读取 PostgreSQL 记忆，只返回 active、
   有效期内且仍有 active 来源的记录；没有记忆时返回空结果，数据库异常安全转换。
4. 本切片没有实现 `contact_memory_index`、`memory_revision`、自动提取、`extract_failed`、
   来源删除任务级联清理或 UI。

验证结果：`notalone_conversation_test`（001-009 迁移）上的 integration 63/63、unit 97/97
通过；`compileall` 与 `git diff --check` 通过；测试后 owner、contact、source、message、
memory_candidate 和 confirmed_memory 均为 0 行。默认 `notalone_test` 全量仍为 123 个测试中的
3 个既有失败、22 个旧 schema 错误和 6 个跳过，原因是该库未应用现行迁移；本任务没有新增
失败或错误。
