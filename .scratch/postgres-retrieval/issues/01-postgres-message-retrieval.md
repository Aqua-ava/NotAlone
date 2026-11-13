# 01 — 实现 PostgreSQL 消息检索

Type: task
State: resolved
Triage: ready-for-agent

**What to build:** 实现 `RetrievalPort.search_messages` 的 PostgreSQL 只读适配器，并按
`owner_id + contact_id`、来源状态和确定性排序返回 `RetrievedMessage`。

- [x] 使用匿名合成数据验证 owner/contact 隔离。
- [x] 排除非 `active` 来源的消息，包括删除流程中的来源。
- [x] 支持关键词、limit、目标消息优先和媒体占位文本。
- [x] 数据库失败转换为稳定的 `RetrievalError`，不暴露 SQL、连接信息或正文。
- [x] 从持久化适配层导出 `PostgresRetrieval`；关系记忆检索显式 fail closed，不实现 MemoryPort。

## Comments

- 2026-08-21：开始按 TDD 实现；先写 PostgreSQL 集成测试，再实现一个垂直切片。

## Answer

已完成 `PostgresRetrieval.search_messages`。适配器只读取当前 owner/contact 范围内 active 来源
的规范化消息，支持多关键词全匹配、近期排序、目标消息置顶、媒体占位和稳定错误转换；没有新增
关系记忆表，也没有修改 Memory 生命周期。

验证：当前迁移数据库 integration 55/55、unit 97/97 通过，`compileall` 和 `git diff --check`
通过，测试数据已清理为 0 行。默认旧 schema 的全套测试仍保留原有 3 failures、22 errors 和
5 skips。
