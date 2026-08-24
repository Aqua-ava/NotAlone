# 01 — Skill 包导入与原子发布

Type: task

**Triage:** ready-for-human
**State:** resolved

**What to build:** 用户明确选择一个本地 Reply Skill 包并通过 `SkillLibraryManagementPort` 导入；包完成完整校验后，以 Owner 全局、不可变的首个版本原子发布，并立即成为 current 和 active。

**Blocked by:** None — can start immediately.

- [x] 包必须包含合法的 `SKILL.md`，正确解析 `name`、`description` 和正文；名称与包目录一致，并满足官方名称格式和编码要求。
- [x] 允许受控的 `references/` 和 `assets/` 作为版本绑定资源；包中出现脚本、越权能力声明、外部运行时 URL 或不支持的资源类型时拒绝导入。
- [x] 拒绝路径遍历、符号链接逃逸、超大文件、超出加载预算的内容、明显联系人或聊天隐私，以及会扩大系统权限的指令。
- [x] `SKILL.md` 与所有辅助资源必须全部校验通过后，才在一个事务中创建 Skill、首个版本和资源记录；任一失败都不留下目录项、版本或半成品资源。
- [x] 首个有效版本自动成为 Owner 全局的 current、active 版本；同一 Owner 下名称唯一，普通重复导入不能静默覆盖；不同 Owner 之间保持隔离。
- [x] 保存来源定位、内容哈希、校验结果和资源元数据，但不保存原始教学视频或无关聊天资料；成功变更只递增一次 `skill_library_revision`。
- [x] 质量问题可以形成用户可见警告，但不能绕过结构和安全硬校验；导入结果能说明成功、警告或拒绝原因。
- [x] 通过管理 Seam 和合成 PostgreSQL 数据覆盖正常导入、损坏包、非法资源、重复名称、原子回滚和 Owner 隔离。

## Comments

- 来源规格：`.scratch/skill-library/spec.md`。
- 本票只负责建立管理入口、包校验、版本化持久化和首个版本发布；Reply Runtime 读取资源由第 02 票负责。
- 原始教学视频清洗、Style Sample、网络安装、脚本执行和外部发送不在本票范围内。

## Answer

已完成 Ticket 01：`PostgresSkillLibrary` 通过 `SkillLibraryManagementPort.import_package` 接收用户明确选择的本地 Skill 包。

1. `LocalSkillPackageReader` 负责受控目录读取；`SkillPackageValidator` 负责 frontmatter、名称/描述、UTF-8、大小预算、路径、符号链接、资源类型、哈希、隐私和指令安全校验。v1 只保留文字资源和经过扫描的 SVG；脚本、栅格图片、视频/音频、压缩包、外部引用和联系人/聊天导出字段会拒绝。
2. 通过校验后在一个 PostgreSQL 事务中创建 Owner 全局 `reply_skill`、不可变首个版本和 `references/assets` 资源记录；首个版本立即成为 `current + active`，同一 Owner 同名导入不会静默覆盖，不同 Owner 隔离，目录 revision 只递增一次。
3. 新增资源表和 `validation_warnings`，保存来源哈希、正文/资源哈希、资源元数据和质量警告；数据库中途失败会回滚目录、版本、资源和 revision。
4. 相关提交：`fa17b4e`、`32ef814`、`cd1e0b6`、`3c4e4ea`、`eb20d47`。双轴代码复审无新的 P0-P2；仅保留重复路径/后缀判断的 P3 smell。

验证结果：`tests/integration/persistence/test_postgres_skill_library.py` 23/23 通过；全仓 `python -m unittest discover -s tests` 421/421 通过、2 个按条件跳过；`compileall` 和 `git diff --check` 通过。测试只使用合成 Owner、Contact、Skill 和本地 `notalone_test` 数据库，未读取或写入真实聊天、教学视频或生产数据。

后续边界：第 02 票再实现运行时的资源读取；更新、启停、删除、导出和试用仍由后续 tickets 完成。
