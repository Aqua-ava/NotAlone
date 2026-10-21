# 10 Skill FS 错误与路径防御

Triage: ready-for-agent
State: resolved
Blocked by: 08

## 目标

区分「目录不存在」与「读取失败」；读取失败不把既有技能批量下架。补齐清理末段路径校验与目录发现符号链接拒绝。

## 证据

- `skill_directory.py:49-66`：根目录 OSError/SkillFileError → `return {}`；`:160-166` 随后 `directory_available=false`。
- `skill_files.py:257-259` 清理只校验父路径，末段未校验 `..`（当前写入方不可达）。
- `skill_directory.py:53-62` 目录发现不拒绝子目录符号链接。
- 复核：`verify-backend.md` B3。

## 范围

- `_read_packages` 区分不存在/读取失败；读取失败保留上一有效状态并记录（与 09 状态衔接）。
- 清理路径对末段做 `_validate_name`/`..` 检查。
- 目录发现拒绝 symlink 子目录（或改用不跟随链接的读取）。
- 测试：模拟根目录不可读、瞬时 OSError、symlink 目录、清理路径 `..`。

## 验收

- Skill 单测/集成测试；报告威胁模型与不可达路径不夸大为可利用漏洞。

## Comments

- 改动：`skill_directory._read_packages` 改为返回 `_ReadPackages`，区分「目录不存在/空」与「读取失败」：根路径被符号链接替换、根不可读等整体读取失败返回 `root_failed` 且不修改既有 `directory_available`/不批量下架；单个包 `OSError` 记录 `failed_names` 并保留该技能上一有效状态；包结构非法仍按原语义只影响自身并记录 `invalid_package`；子目录符号链接直接拒绝并记录 `symlink_rejected`，不再跟随把根外文件导入版本快照。失败码经 `record_skill_file_failure(operation="directory_discovery")` 写入 09 的健康状态（`state=degraded` + 固定错误码），成功恢复后清除；最终候选复验的只读检查遇到根/单包读取失败按「无变化」处理，不因瞬时 FS 错误误判迟到候选。路径防御：抽取 `_validate_relative_path` 供 `_checked_path` 与 `cleanup_pending_files` 共用，清理前校验整条相对路径（拒绝空段、`.`/`..`、绝对路径、反斜杠、重复斜杠，末段同样受限），单段清理路径（owner 根）正确落到 Skills 根；父目录仍经 `_checked_path` 校验且不跟随符号链接。
- 验证命令与结果：新增 `tests/integration/persistence/test_postgres_skill_fs_defense.py`（4 OK：根读取失败保留上一有效目录并恢复、非法包不可用+状态可查+恢复、symlink 子目录拒绝且不导入外部内容、清理路径 `..` 逃逸被拒且根外目录/文件完好）。相关模块回归：`test_postgres_skill_file_health`(2)、`test_postgres_skill_read_path`(4)、`test_postgres_skill_directory`(19)、`test_postgres_skill_deletion`(6)、`test_postgres_skill_lifecycle`(10)、`test_postgres_skill_library`(29)、`test_postgres_skill_port`(7)、`test_postgres_reply_store`(19)、`test_postgres_skill_export`(3) 全 OK。
- 威胁模型：清理表 `..` 行在当前所有写入方均用 UUID/slug 模板拼接时不可达，属「持久化数据被篡改/历史异常行/未来新写入方」的纵深防御，不夸大为可利用漏洞；失败后该行保留并计入健康状态（`pending_cleanup_files` 只统计可归属当前 owner 的异常行，无法归属的行保留待人工核对）。symlink 子目录由用户有意在自己的管理目录放置时可达，修复前会把根外文件导入版本快照，修复后拒绝并保留旧版本可执行。瞬时根不可读（卷未挂载/权限）此前会把技能批量下架，现在保留上一有效状态并记录可查询失败码。
- 数据/隐私影响：日志仅固定事件名与固定错误码；健康状态只含计数、错误码、不可识别 UUID，不含真实/相对路径与正文。无数据库迁移、不改变删除屏障/来源核验/隔离/人工发送边界。
- 剩余风险：目录发现失败状态仍为进程内（重启后只剩计数类持久待办），跨进程历史原因不可查；无效清理行会持续计入 degraded 且不会自动删除，需人工核对数据库；TOCTOU（校验与读取之间替换）在同一 UID 下风险低，仍记录备查；`synchronize_skill_directory(check_only=...)` 参数现仅用于只读变化检查，删除留给 14。
