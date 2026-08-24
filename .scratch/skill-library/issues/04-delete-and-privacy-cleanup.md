# 04 — Skill 删除与隐私清理

Type: task

**Triage:** ready-for-agent
**State:** open

**What to build:** 用户明确删除一个 Skill 后，系统清除该 Skill 的全部版本、正文、辅助资源、来源定位和可恢复运行数据，并使目录与 Reply Runtime 立即无法重新加载；只保留最小不可恢复的删除凭证。

**Blocked by:** 01、02、03 — 删除必须覆盖已发布的包、运行时资源缓存和多版本生命周期。

- [ ] 删除操作必须验证 Owner 归属并覆盖该 Skill 的所有版本、`SKILL.md` 正文、`references/`、`assets/`、来源定位、资源内容和内容哈希等可恢复数据。
- [ ] 同步清除目录缓存、资源读取结果、Skill Tool 结果、包含旧正文的摘要和其他可使 Skill 恢复可用的运行状态；历史关联如需保留，只能是不含正文的最小删除凭证。
- [ ] 删除完成前不能写入“已删除”假象；事务失败时保留可重试的一致状态，不留下半删版本或孤立资源。
- [ ] 删除后目录查询和版本加载返回受控的不存在/已删除结果，Reply Runtime 不能使用旧缓存，并按无 Skill 路径继续候选生成。
- [ ] 重复删除具有幂等行为并返回稳定的最小凭证；删除一个 Owner 的 Skill 不影响其他 Owner 或其他 Skill。
- [ ] 删除使 Owner 的 `skill_library_revision` 原子递增一次，并使相关目录、资源和运行时缓存失效。
- [ ] 使用合成 PostgreSQL 数据覆盖单版本、多版本、删除竞态、缓存失效、失败回滚、重复删除和 Owner/Skill 隔离；断言正文、资源和来源不可检索。

## Comments

- 来源规格：`.scratch/skill-library/spec.md`。
- 本票遵守现有删除边界，不删除联系人、聊天、Relationship Memory 或 Style Sample。
