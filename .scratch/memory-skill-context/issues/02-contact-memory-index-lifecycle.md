# 02 — L2 联系人记忆目录与失效

**What to build:** 用户生成候选回复时，系统可以使用当前联系人有效关系记忆的精简场景/主题目录定位相关资料；当记忆更新、失效或删除时，旧目录和派生索引不会继续影响回复。

**Blocked by:** 01 — 关系记忆的采纳状态、来源和有效期规则必须先确定。

**Status:** ready-for-agent
**State:** resolved
**Triage:** ready-for-agent

- [x] L2 只从有效的 L0/L1 及其来源生成，保存少量主题入口和有效记忆引用。
- [x] L2 不复制全量聊天正文，不产生脱离权威记忆的新事实。
- [x] 记忆新增、修改、分类变化、过期或删除后，目录 revision 发生变化，旧目录不能继续参与回复。
- [x] 目录由可重试、幂等的后台任务增量更新或重建；重建完成前不会引用已失效资料。
- [x] 用户的候选回复可以通过 L2 找到相关 L1，但 L2 本身不会被当作最终事实。
- [x] 删除底层来源后，相关目录、全文索引、缓存和运行摘要均不可继续检索。
- [x] 使用合成联系人验证版本不一致、删除、重建失败和重复任务行为。

## Answer

已完成 L2 联系人记忆目录生命周期：

1. `PostgresContactMemoryIndexRepository` 只从当前有效、来源仍可用的 `confirmed_memory` 生成最多 20 个分类/主题入口；目录只保存主题和 UUID 引用，不复制聊天正文或生成事实。
2. 新增 `locate_memory_ids` 导航接口。回复 Context 先读取当前 L2，再把导航到的 ID 交给 Retrieval 重新读取 L1；目录过期、来源删除或目录不可用时不使用旧导航并回退到权威检索。
3. Retrieval 的联系人记忆查询增加受控 ID 过滤，InMemory/PostgreSQL 行为一致；Worker 的 index/verify、增量更新、重建失败回滚和 source deletion stale 语义保持可重试、幂等。
4. 新增合成测试覆盖 L2 导航只返回当前引用、版本过期、删除后重建为空、上下文通过 L2 缩小 L1，以及既有隔离/重建失败路径。未引入聊天正文副本、向量库或外部数据。

验证：`python -m unittest tests.unit.reply.test_context_retrieval tests.unit.retrieval.test_retrieval tests.integration.persistence.test_contact_memory_index tests.integration.reply.test_postgres_reply_flow`（20 个通过）；`python -m compileall -q src tests` 和 `git diff --check` 通过。
