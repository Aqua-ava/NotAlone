# 07 — 接入 PostgreSQL SkillPort

Type: task
State: resolved
Triage: ready-for-agent

**What to build:** 将只读 SkillPort 接入 PostgreSQL，为当前 owner 和 contact 提供正确的 Skill 目录、不可变版本正文和 owner 级修订，同时拒绝跨范围、禁用、删除或版本不一致的读取。

**Blocked by:** 02 — 统一回复与改写输入。

**Status:** PostgreSQL SkillPort 已完成；回复 Skill 选择审计字段保留为后续公共合同工作。

- [x] 目录只返回当前 owner 的全局 Skill 和当前 contact 的专属 Skill，并排除禁用或已删除版本。
- [x] Skill 正文按不可变版本读取；目录读取同时返回 owner 级 revision，现有 Runtime 会拒绝与上下文 revision 不一致的旧目录。
- [x] 跨 owner/contact、未知、禁用、删除或版本不一致的请求统一安全失败，不泄漏存在性细节。
- [x] Reply Runtime 每次最多使用一个 Skill，并能保存实际版本摘要。
- [ ] Reply 请求的选择方式、简短原因和可空置信度字段：当前 `AutoSkill`/`SkillUse` 公共合同尚未提供这些字段，本次不为 PostgreSQL adapter 臆造显式选择语义。
- [x] SkillPort 只提供读取能力，不新增安装、网络下载、更新、启用、禁用、删除或外部发送能力。
- [x] 使用匿名合成 Skill 完成 PostgreSQL 约束和隔离测试，框架类型不泄漏到 Reply 公共接口。

## Answer

已完成 PostgreSQL SkillPort 的只读纵切：

1. 新增 `database/migrations/008_skill_port.sql`，建立 owner 级 `skill_library` revision、
   `reply_skill` 目录项和 `reply_skill_version` 当前/不可用版本约束；同一 owner 内名称唯一，
   global/contact Skill 通过复合外键隔离。
2. 新增 `PostgresSkillPort`，只暴露 `catalog(scope)` 和 `load_version(scope, version_id)`。
   两个读取都使用 `REPEATABLE READ, READ ONLY` 事务，目录只返回当前范围的 active/current/enabled
   版本；数据库异常和不可用版本不暴露 SQL、连接信息、Skill 正文或存在性细节。
3. 从 `notalone.persistence` 导出 adapter 和稳定的 `SkillPortPersistenceError`，没有增加安装、
   网络、更新、删除或外部发送能力；README 已补充 008 迁移顺序和边界。
4. 增加匿名合成 PostgreSQL 集成测试，覆盖 global/contact 隔离、owner revision、旧/禁用/删除/
   跨范围/未知版本统一失败、名称唯一、空目录、数据库错误和只读 surface。

验证结果：隔离数据库 `notalone_conversation_test` 已应用 001-008 迁移；
`tests/integration/persistence` 40/40 通过，`tests/unit` 97/97 通过，`compileall` 和
`git diff --check` 通过，测试库清理后 `owner`、`skill_library`、`reply_skill` 和
`reply_skill_version` 均为 0 行。默认 `notalone_test` 仍停留在旧 001 schema，全量 123 个测试为
3 个既有导入失败、22 个既有 PostgreSQL schema 错误和 3 个跳过，原因是缺少
`channel_identity`、`wechat_message_metadata` 等现行迁移表。

剩余边界：当前 Reply public contract 只有 `AutoSkill` 和 `SkillUse(skill_id, version_id, name)`，
尚未表达用户显式选择、选择原因或置信度；该字段扩展应在明确 Reply 审计合同后单独实现，不由只读
SkillPort adapter 推断。
