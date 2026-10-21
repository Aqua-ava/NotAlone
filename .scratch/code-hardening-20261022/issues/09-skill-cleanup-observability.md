# 09 Skill 清理失败可观测

Triage: ready-for-agent
State: resolved
Blocked by: 08

## 目标

清理/工作副本同步失败不再静默 `continue` 导致技能永久从可执行目录消失：失败保留任务但写入可查询状态/日志，且不用「整技能排除」表达待清理。

## 证据

- `backend/src/notalone/persistence/skill_files.py:223-224`（`synchronize_working_copies` 失败 continue）、`:269-270`（`cleanup_pending_files` 失败 continue）。
- `skill_directory.py:69-84` + `skill_port.py:65-69`：pending/cleanup 通过 NOT EXISTS 排除整个技能。
- 复核：`verify-backend.md` B1。

## 范围

- 失败记录 warning（脱敏）+ 可查询的健康/失败状态（与 02 的 runtime status 模式一致，不新增泄露）。
- 可重试：失败任务保留并指数/下次心跳重试；不改变删除屏障的产品语义。
- 确保运行资格查询仍 fail-closed，但状态可解释（例如「目录待清理」而不是静默消失）。
- 测试：注入哈希/权限失败，断言技能不可执行 + 状态可查 + 修复后恢复；现有生命周期/删除测试全绿。

## 验收

- Skill 集成测试 + 相关模块；报告故障注入方式与恢复路径。

## Comments

- 改动：`skill_files.py` 不再静默 `continue`。工作副本同步与待清理文件失败时写入脱敏 warning（固定事件名 `skill_file_sync_failed operation=<working_copy_sync|cleanup> code=<permission_denied|filesystem_error|file_unavailable|unknown_error>`，不含路径/正文/联系人信息），保留原任务行供下次显式同步重试；成功重试后清除进程内失败记录。新增 `SkillFileFailure` 进程内登记表（有界 512 条，owner 隔离）、`read_skill_file_failures(owner_id)` 与 `skill_file_health(connection, owner_id)`，健康状态只含 `state`、`pending_working_copies`、`pending_cleanup_files`、`failures[{operation,code,skill_id,occurred_at}]`，不暴露相对/真实路径与正文；`PostgresSkillLibrary.skill_file_health(owner_id)` 提供可查询入口。`skill_directory.synchronize_skill_directory` 对待重试替换/清理阻塞的技能保留上一有效 `directory_available`，不再因一次失败把它们批量标记下架；运行资格查询仍按 `reply_skill_working_copy`/`reply_skill_file_cleanup` 的 NOT EXISTS fail-closed（失败期间不可执行），重试成功后自动恢复；同时修正 `_blocked_working_directories` 对隐藏快照/暂存清理行的技能名解析，只把可编辑工作目录映射为待清理技能名。
- 验证命令与结果：新增 `tests/integration/persistence/test_postgres_skill_file_health.py`（2 OK，注入快照哈希错误与 `shutil.rmtree` PermissionError，断言 warning、任务保留、技能不可执行、状态可查且无路径/正文、修复后恢复 ok）。相关模块回归：`test_postgres_skill_directory`(19)、`test_postgres_skill_deletion`(6)、`test_postgres_skill_lifecycle`(10)、`test_postgres_skill_library`(29)、`test_postgres_skill_read_path`(4) 全 OK。
- 数据/隐私影响：状态与日志新增均为固定错误码与计数，`skill_id` 为不可识别 UUID；不写库新增表/字段（无迁移），不改变删除屏障、来源核验、owner/contact 隔离与人工发送边界。
- 剩余风险：失败状态为进程内（本机单进程后端可查询，重启后仅剩持久化待办计数与任务行），跨进程/重启后的历史失败原因不可查；失败重试按每轮显式同步节奏，无指数退避，若每轮都失败会每轮记一条 warning（限流留给 02 类运行时状态模式扩展）；`skill_file_health` 尚未接到 HTTP 状态投影（app.py 不在本 ticket 写范围）。

- 2026-10-22 复核修复：`/api/runtime/status` 增加 `skill_files` 健康投影（`SkillService.skill_file_health`，读取失败只 warning 不拖垮状态）；健康状态包含 DB pending 计数，重启后仍为 degraded，但进程内 failures 明细会丢失（已知限制）。
- 有意偏离：catalog 仍用 `working_copy`/`cleanup` 的 NOT EXISTS 把待清理技能整体排除，优先保证运行资格 fail-closed；未改成「列出但标不可用」，避免在删除屏障完成前暴露可执行条目。所需的产品确认已登记到 `review-followups.md`。
