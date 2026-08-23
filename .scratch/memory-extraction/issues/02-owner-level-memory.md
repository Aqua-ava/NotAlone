# 02 — owner 级自我记忆存储与拼接检索

**What to build:** 用户自身事实的独立归属层：新增 owner 级记忆存储（无联系人归属，PostgreSQL 迁移跟随现有序列），主体为 self 的事实写入 owner 级；检索时 owner 级与联系人级两路合并拼接（借鉴 Claude Code 双层拼接，互不覆盖）；来源、采纳标记、删除路径与联系人级记忆同等约束。

**Triage:** ready-for-agent
**State:** resolved
**Blocked by:** None — can start immediately（与 01 并行）

- [x] 迁移新增 owner 级记忆表，含来源、分类、主体、采纳方式、有效期、状态与软删除字段
- [x] owner 级记忆 port 扩展：写入、列出、修正、删除与软删除指纹
- [x] 检索拼接：同一查询合并 owner 级 self 记忆与联系人级关系记忆，各自带范围与来源
- [x] 跨 owner 隔离：owner 级记忆按 owner 隔离，集成测试验证不可串读
- [x] 软删除保留文本指纹，删除后不可检索
- [x] PostgreSQL 集成测试沿用隔离测试库与合成数据惯例

## Comments

## Comments（实现记录）

- 2026-08-23 完成。迁移 011 建 owner_memory 表（FK owner、五类+受控主题、来源数组、采纳方式、软删除状态、有效期、版本）；`OwnerMemory` 值对象与 `OwnerMemoryPort` 入 memory 域，`PostgresOwnerMemoryStore` 提供写入、active 列出（含有效期过滤）、软删除与删除指纹查询。
- 检索拼接：`PostgresRetrieval` 新增 `search_owner_memories(owner_id)`（active、有效期内、关键词过滤、limit 预算），与既有 `search_confirmed_memories` 两路由调用方合并，各自带范围与来源；`RetrievedOwnerMemory` 携带 topic。
- 顺带把 `MemoryTopic`/`FactSubject` 上移到 memory 域模型（memory_extraction re-export 保持兼容），消除 03 落库时的循环依赖。
- 验证：owner 记忆集成测试 7 例（写入、隔离、软删指纹、检索含过期排除）；全量 216 例通过（1 例冒烟按凭据跳过）。测试库与 dev 库均已应用 011。
