# 09 Skill 清理失败可观测

Triage: ready-for-agent
State: open
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
