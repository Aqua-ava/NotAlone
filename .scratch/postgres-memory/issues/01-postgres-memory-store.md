# 01 — 实现 PostgreSQL MemoryStore

Type: task
State: resolved
Triage: ready-for-agent

**What to build:** 将当前 `MemoryPort` 的候选与已确认记忆生命周期接入 PostgreSQL，并让
`PostgresRetrieval` 能读取当前有效的已确认记忆。

- [x] 新增 `memory_candidate`、`confirmed_memory` 表和 `uuid[]` 来源字段。
- [x] 实现候选创建、确认幂等、修正、拒绝、失效、记忆失效、删除和范围隔离。
- [x] 实现 active/validity/source-aware 的 `search_confirmed_memories`。
- [x] 数据库失败转换为稳定错误，不泄露 SQL 或敏感正文。
- [x] 不实现 `contact_memory_index`、自动提取、后台删除级联或 UI。

## Comments

- 2026-08-21：开始按 TDD 实现；先测试当前 MemoryPort 的公开行为。

## Answer

已完成 MemoryPort 的 PostgreSQL 持久化和 Retrieval 记忆查询。当前关系记忆会按联系人范围、
状态、有效期和 active 来源过滤；来源 UUID 不属于当前 scope 时，候选写入会拒绝。确认、修正、
失效和删除均保留状态与 revision，重复确认会返回原记忆。

验证：现行迁移库 integration 63/63、unit 97/97、compileall 和 diff check 通过；测试数据已
清理。来源删除后候选/记忆派生行的任务级联清除和 `contact_memory_index` 仍是后续任务。
