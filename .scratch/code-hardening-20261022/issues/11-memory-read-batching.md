# 11 记忆读取批量化

Triage: ready-for-agent
State: resolved

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

- 回归测试（先红后绿）：
  - `backend/tests/integration/persistence/query_counting.py`：可计数 psycopg 连接子类（统计 SQL 条数，不做耗时 profiling）。
  - `backend/tests/integration/persistence/test_memory_read_batching.py`：断言 `list_confirmed`/`list_active` 的 SQL 条数与行数无关（1 行 vs 5 行相等）、预热后重复读取不再发结构探针、contact confirm 来源校验次数。修复前 1 行与 5 行查询数分别为 7/15（代码路径静态计数：5 + 每行 2 条），5 行读取含 10 条逐行探针；修复后可计数连接实测两者均为 5 条、重复读取探针 0 条。
  - `backend/tests/unit/persistence/test_schema_capabilities.py`：正向缓存命中、缺失不缓存、探针异常不缓存且上抛、无数据库身份不缓存、不同库不共享、空值不缓存。
- 实现（列表/召回热路径）：
  - `memory_evolution.py`：新增 `bind_memory_evolutions` 按批绑定；列探针每批一次（缓存），本批关联反证候选一次查询后内存匹配 `memory_id+revision`，保持原 `created_at DESC` 与每个记忆最多 8 条复验的语义；单行 `bind_memory_evolution` 复用批实现。
  - `memory_conditions.py` / `memory_events.py`：新增 `bind_memory_conditions_rows` / `bind_memory_events_rows` 与 `candidate_rows_by_id`，本批候选行一次查询；单行入口改为同一判定函数的薄包装。
  - `memory_versions.py`：新增 `bind_version_evidence_rows`，父版本行整批一次查询；`validate_version_sources` 仍逐行复验冻结窗口（语义不变）。
  - `memory_store._timed_memories` / `owner_memory_store._timed_rows` 改为四个 bind 全部按批；`timed_memory_rows` 原本已批处理。
- 结构探针缓存：新增 `backend/src/notalone/persistence/schema_capabilities.py`，只缓存「确认存在」的正向结果，按数据库身份（host/port/dbname/user）键控；未知连接/旧库缺失/探针异常一律不缓存并保持原 fail-closed 分支。接入探针：`memory_events.has_event_schema`、`memory_correction.has_correction_schema`、`memory_conditions.conditions_clear_sql`、`source_dependency.require_lifecycle_schema`、`dimension_evidence.has_dimension_evidence`、`memory_evolution` 列探针。
- 有意不缓存（避免掩盖运行期 schema 变化）：`supports_dimension_evidence_version`/`supports_bounded_runtime_evidence`（迁移能力门，测试/评测会故意破坏约束验证 fail-closed，且不在读热路径）、`_pending_candidate_columns`（每列表调用一次，且测试会在同一事务内临时改名可选列）、`memory_correct` 内退役列探针（写路径，测试会 `DROP COLUMN` 验证部分结构拒绝）。
- 验证命令与结果：
  - `cd backend && PATH="$HOME/miniconda3/envs/NotAlone/bin:$PATH" perl -e 'alarm 1200; exec @ARGV' -- python -m unittest tests.unit.persistence.test_schema_capabilities tests.unit.memory tests.unit.persistence tests.integration.persistence.test_memory_timing tests.integration.persistence.test_memory_merge tests.integration.persistence.test_all_source_persistence tests.integration.persistence.test_dimension_evidence tests.integration.persistence.test_dimension_evidence_v2 tests.integration.persistence.test_dimension_evidence_v3 tests.integration.persistence.test_bounded_runtime_migration tests.integration.persistence.test_memory_read_batching tests.integration.persistence.test_pending_candidate_projection` → `Ran 138 tests ... OK`。
  - `python -m unittest tests.integration.server.test_memory_api tests.integration.server.test_memory_integration tests.integration.persistence.test_pending_candidate_projection` → 通过；同批 `test_layered_memory_management` 失败为环境既有：`KeyError: 'NOTALONE_TEST_DATABASE_URL'`（`tests/integration/server/memory_overview_support.py:33` 要求外部注入该变量，与本改动无关）。
  - `python -m unittest tests.integration.server.test_memory_timeline tests.integration.server.test_memory_evolution_reply` → `Ran 22 tests ... OK`（覆盖变化依据/条件/事件的批绑定读路径）。
  - 环境说明：默认 `notalone_test` 仍停留在无迁移账本旧结构，依赖它的 `tests.integration.persistence.test_postgres_memory_store` 在改动前即为 16 errors/1 failure（schema 未应用），本次未将其作为失败依据；记忆验证使用隔离随机测试库。
- 数据影响：只改读取路径与探针缓存，无 schema/数据写入变化；返回结构、排序、删除/失效/来源校验语义不变。
- 剩余风险：`list_pending_candidates` 的 `_timed_candidates` 仍逐行 `protect_candidate`/维度依据复验（不在本 ticket 的热路径范围）；`bind_version_evidence_rows` 仍逐行复验冻结来源窗口，只批量化父版本行查询；查询次数为静态 SQL 计数，未做耗时 profiling。
- 提交：`dc5cd179、52276df6`。
