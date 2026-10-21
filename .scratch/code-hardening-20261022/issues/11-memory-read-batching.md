# 11 记忆读取批量化

Triage: ready-for-agent
State: open

## 目标

消除记忆列表/召回逐行 N+1 查询与每次调用重复 schema 探针：按批一次查询后内存关联；schema 探测启动/首次缓存，旧库守卫保持 fail-closed。

## 证据

- `backend/src/notalone/persistence/memory_store.py:1711` 附近、`owner_memory_store.py:954` 附近逐行 `bind_memory_*`。
- `memory_extraction/memory_evolution.py:51-70` 每值固定两条查询（含 `pg_attribute` EXISTS）。
- 16 个 helper 调用点 + 约 20 处 inline schema 探针（复核清单见 `verify-backend.md`）。
- 复核：`verify-backend.md` A7。

## 范围

- 列表/召回路径批量化；不改变返回结构、排序与删除/失效语义。
- schema 探针缓存限定「已确认迁移完成」的正常运行时；旧库/未迁移库行为保持 fail-closed 并可测试。
- 单条读取路径不强制重构；先做热路径。
- 测试：查询次数断言（用可计数连接/游标）、既有记忆集成测试全绿。

## 验收

- 记忆相关单测 + 集成；报告近似往返次数前后对比（静态计数，不做 profiling 声称）。

## Comments
