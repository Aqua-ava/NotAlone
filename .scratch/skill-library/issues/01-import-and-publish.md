# 01 — Skill 包导入与原子发布

Type: task

**Triage:** ready-for-agent
**State:** open

**What to build:** 用户明确选择一个本地 Reply Skill 包并通过 `SkillLibraryManagementPort` 导入；包完成完整校验后，以 Owner 全局、不可变的首个版本原子发布，并立即成为 current 和 active。

**Blocked by:** None — can start immediately.

- [ ] 包必须包含合法的 `SKILL.md`，正确解析 `name`、`description` 和正文；名称与包目录一致，并满足官方名称格式和编码要求。
- [ ] 允许受控的 `references/` 和 `assets/` 作为版本绑定资源；包中出现脚本、越权能力声明、外部运行时 URL 或不支持的资源类型时拒绝导入。
- [ ] 拒绝路径遍历、符号链接逃逸、超大文件、超出加载预算的内容、明显联系人或聊天隐私，以及会扩大系统权限的指令。
- [ ] `SKILL.md` 与所有辅助资源必须全部校验通过后，才在一个事务中创建 Skill、首个版本和资源记录；任一失败都不留下目录项、版本或半成品资源。
- [ ] 首个有效版本自动成为 Owner 全局的 current、active 版本；同一 Owner 下名称唯一，普通重复导入不能静默覆盖；不同 Owner 之间保持隔离。
- [ ] 保存来源定位、内容哈希、校验结果和资源元数据，但不保存原始教学视频或无关聊天资料；成功变更只递增一次 `skill_library_revision`。
- [ ] 质量问题可以形成用户可见警告，但不能绕过结构和安全硬校验；导入结果能说明成功、警告或拒绝原因。
- [ ] 通过管理 Seam 和合成 PostgreSQL 数据覆盖正常导入、损坏包、非法资源、重复名称、原子回滚和 Owner 隔离。

## Comments

- 来源规格：`.scratch/skill-library/spec.md`。
- 本票只负责建立管理入口、包校验、版本化持久化和首个版本发布；Reply Runtime 读取资源由第 02 票负责。
- 原始教学视频清洗、Style Sample、网络安装、脚本执行和外部发送不在本票范围内。
