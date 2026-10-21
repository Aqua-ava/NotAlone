# 08 Skill 读路径去写化

Triage: ready-for-agent
State: open

## 目标

`SkillPort.catalog/load_version/load_resource` 与最终候选复验不再各自执行迁移 + 全目录同步/写入；发现与同步收敛到每轮/每次生成一次的显式入口，读路径保持只读。

## 证据

- `backend/src/notalone/persistence/skill_port.py:129-175`、`:88-112`：每次读都 `_prepare_directory`（新连接+owner 锁+迁移）与 `_synchronize`（全目录扫描+逐包校验+写库/写文件）。
- `backend/src/notalone/server/reply_wiring.py:267-279` 同样每次读 revision 都 prepare+synchronize。
- `catalog` 未捕获 `SkillFileError` → 500。
- 复核：`verify-backend.md` B2。

## 范围

- 保留 ADR-096「管理目录与每轮运行前自动发现」语义：入口收敛（例如生成/准备开始时显式同步一次，读路径用 revision/已同步标记判断）。
- 读路径不写库、不写文件、不持 owner 锁；`catalog` 捕获 `SkillFileError` 并映射为领域错误/SkillPortPersistenceError。
- 落盘/迁移失败可重试且状态可见（与 09 衔接）。
- 测试：计数断言（读 API 不触发迁移/同步 SQL、不写文件）；现有 SkillPort/Skill 生命周期测试全绿。

## 验收

- 相关 Skill 集成测试 + reply 相关模块；报告每轮生成实际同步次数。
- 先读 `architecture/adr/096-directory-backed-reply-skills.md` 与 `.scratch/directory-reply-skills/spec.md` 核对语义。

## Comments
