# 03 skill_files 清理路径缺陷

Triage: ready-for-agent
State: resolved

## 目标

修复加固轮新缺陷：`persistence/skill_files.py:475,488` 在清理成功/失败分支内再调 `_cleanup_skill_id(connection, …)` 查库，DB 抖动会从 except 处理器抛出并中断整批清理；同时去掉每行多一次查询。

## 证据

`.scratch/code-audit-20261022/verify-structure-defense.md` 第三节 D1；源码 `backend/src/notalone/persistence/skill_files.py:465-492`。

## 范围

- 清理循环内先一次性取 `skill_id`（若可），或在失败记录中使用不查库的替代归因；异常处理路径不得再执行可抛出的 DB 查询。
- 保持 `SkillFileFailure` 归因语义（有 owner 时仍记录），保持清理失败可重试与可观测。
- 不改变「清理失败不能恢复内容」的既有边界。

## 验收

- 新增/更新单测：注入 DB 查询失败（或 mock 掉再查库路径），断言整批清理不中断、失败被记录、成功行仍计数。
- `cd backend && PATH="$HOME/miniconda3/envs/NotAlone/bin:$PATH" python -m unittest tests.unit.persistence.test_skill_files -v`（按实际模块）通过。

## Comments

- 2026-10-22 backend-cleaner 完成：
  1. `backend/src/notalone/persistence/skill_files.py`：`cleanup_pending_files` 在循环前调用新 `_cleanup_skill_ids(connection, rows)` 一次性解析技能身份；`.versions/`/`.staging/` 路径直接解析，工作目录 `<owner>/<name>` 合并为一次 `WHERE owner_id = ANY(...)` 查询。循环内与 `except`/`else` 路径彻底去掉 DB 查询（原 `_cleanup_skill_id` 删除）。
  2. 失败归因语义不变：有 owner 时仍写 `SkillFileFailure`（operation=cleanup，含解析到的 skill_id），无 owner 时保持 warning；失败行不删清理队列项，成功行仍计数；「清理失败不能恢复内容」边界未动。
  3. 新增 `backend/tests/unit/persistence/test_skill_file_cleanup.py`：合成文件系统 + 假连接，注入工作目录行 `OSError`，断言整批不中断（后续行仍清理计数=1）、失败被记录且 skill_id 由预取解析、循环内无 `AND name=%s` 查询；另断言纯路径行不发起预取查询。
- 验证：`python -m unittest tests.unit.persistence.test_skill_file_cleanup -v` 2/2 通过；`discover -s tests/unit/persistence` 16/16、`discover -s tests/unit/skills` 56/56 通过。
- 数据影响：无数据迁移；清理队列与进程内失败表的语义不变，仅少每行一次查询，多一次（仅在有工作目录项时）批量查询。
- 剩余风险：预取查询失败会在循环前抛出（不再从 except 处理器中断），调用方事务回滚覆盖；Postgres 集成测试（`tests/integration/persistence/*skill*`）本机无测试库未跑，需 Lead/CI 用真实库补验。
