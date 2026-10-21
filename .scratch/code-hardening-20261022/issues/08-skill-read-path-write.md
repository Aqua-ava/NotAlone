# 08 Skill 读路径去写化

Triage: ready-for-agent
State: resolved

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

- 改动：`PostgresSkillPort.catalog/load_version/load_resource` 去写化，只读同一事务内投影，不再迁移、扫描目录、写库或持 owner 锁；`require_reply_skill_current` 移除了「无 Skill 也全目录扫描」，改为先 `skill is None` 直接返回，确有 Skill 时仅做一次只读目录变化检查（无锁、无写入，保留迟到候选失效契约）。新增显式同步入口 `skill_directory.synchronize_skill_library(database_url, owner_id, migrate_legacy=...)`，在单个提交边界内完成旧库迁移、工作副本/清理消费、目录发现与修订号推进，失败整体回滚并抛脱敏领域错误 `SkillDirectorySyncError`，下一轮可重试。`reply_wiring` 装配时同步一次（含旧库迁移，失败降级为上次已同步修订号并 warning），`RoundSkillSyncPort` 在每轮 prepare/generate 前各显式同步一次（prepare-only 与正式生成是两个 HTTP 轮，各一次），`skill_revision_reader` 改为只读修订号。`skill_review.approve` 在发布提交后显式同步一次消费工作副本，失败只 warning 并保留任务。`catalog` 补捕 `SkillFileError` 映射为 `SkillPortPersistenceError`。`tests/integration/persistence/test_postgres_skill_directory.py` 等夹具改为在目录文件变化后调用显式入口再读取；新增 `tests/integration/persistence/test_postgres_skill_read_path.py`（读 API 不触发迁移/同步 SQL、不写文件；显式入口发现与旧库迁移；`SkillFileError` 领域映射；无 Skill 最终复验不扫描目录）与 `tests/unit/skills/test_skill_round_sync.py`（每轮同步一次、失败脱敏 warning 后继续）。
- 验证命令与结果：`cd backend && python -m unittest tests.integration.persistence.test_postgres_skill_read_path`（4 OK）、`tests.unit.skills.test_skill_round_sync`（2 OK）、`tests.integration.persistence.test_postgres_skill_{port,directory,lifecycle,library,deletion}`（7/19/10/29/6 OK）、`tests.integration.server.test_skill_{feedback,review,learning}`（27/26/25 OK）、`test_assistant_generation_prepare`（27 OK）、`test_scenario_read_tool`（43 OK，专用空 `_test` 库）、`test_persistent_reply_exploration`（22 OK）、`test_assistant_session_{api,deletion}`（26/12 OK）、`tests.integration.reply.test_postgres_reply_flow`（8 OK）、`tests/unit/reply`（465 OK）、`tests/unit/skills` OK。本轮每轮生成实际同步：1 次显式同步（prepare-only 与生成分属两轮，各 1 次）；最终复验仅在有 Skill 时做 1 次只读变化检查。部分既有集成套件要求显式环境变量（`NOTALONE_TEST_DATABASE_URL`、`NOTALONE_DATABASE_URL`、`NOTALONE_EXPECTED_TEST_DATABASE`、`NOTALONE_SKILLS_DIR`），属既有运行约定；本机共享 `notalone_test` 结构过期，已按迁移命令重建为最新 102 条迁移（仅本地测试库，未改仓库）。
- 数据/隐私影响：读 API 不再产生目录锁/写事务，无新增日志字段，warning 只有固定事件名 `skill_directory_sync_failed`，不含正文、真实路径、owner/contact 标识；`SkillDirectorySyncError` 与 `SkillPortPersistenceError` 不携带 SQL/路径/正文。删除屏障、来源核验、联系人/owner 隔离、人工发送边界未改动。
- 剩余风险：一是目录编辑的失效检测不再由每次读取触发，最终候选提交时仍会做只读变化检查（有 Skill 时），无 Skill 候选不再因目录变化失效（与修订号语义一致）；二是 `exploration` 首轮选 Skill 直接读目录，若目录刚变化需等下一轮显式同步后才可见（生成轮入口已覆盖）；三是装配时同步失败会以 0/上次修订号降级并 warning，状态可见性与重试细化由 09/10 继续承接；四是 `synchronize_skill_directory(check_only=...)` 参数目前仅剩最终复验使用，删除留给 14 死代码处置。
