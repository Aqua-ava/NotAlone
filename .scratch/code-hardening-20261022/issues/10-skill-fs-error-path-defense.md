# 10 Skill FS 错误与路径防御

Triage: ready-for-agent
State: open
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
