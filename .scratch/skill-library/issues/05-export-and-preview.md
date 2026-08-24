# 05 — Skill 导出与试用预览

Type: task

**Triage:** resolved
**State:** resolved

**What to build:** 用户可以导出一个可移植的 Skill 包，也可以在选定的 Reply Task 上试用指定 Skill；导出不带走联系人资料，试用只生成应用内候选预览，不改变长期数据或发送消息。

**Blocked by:** 01、02 — 导出需要已发布的版本和资源，试用需要 Reply Runtime 的受控加载能力。

- [x] 导出能够重建合法的 `SKILL.md`、允许的 `references/`、`assets/` 和必要包元数据，并保持版本内容与校验结果一致。
- [x] 导出只包含 Skill 包自身数据，不包含其他 Owner、Contact、聊天记录、Reply Task、候选回复、Relationship Memory、Style Sample 或使用日志。
- [x] 试用前验证 Owner、已确认 Contact、选定 Reply Task 和 Skill 版本范围；试用只允许使用当前 Reply Context 和受控 Skill 资源。
- [x] 试用返回可编辑的候选预览，并展示实际 Skill、版本、选择原因、资源加载状态或失败回退原因；不发送外部消息。
- [x] 试用不创建或修改 Relationship Memory、Style Sample、长期偏好、Skill 版本、Skill 状态或 `skill_library_revision`。
- [x] 试用中的 Skill 或资源加载失败时返回无 Skill 预览或受控错误，不泄漏路径、聊天正文、其他 Owner 数据或 Skill 私密正文。
- [x] 使用合成 Skill、Owner、Contact 和 Reply Task 覆盖导出完整性、资料排除、试用成功、试用回退、无持久化副作用和人工发送边界。

## Comments

- 来源规格：`.scratch/skill-library/spec.md`。
- 网络安装、自动导出、自动发送和视频清洗流程不在本票范围内。

## Answer

已完成 Ticket 05：`PostgresSkillLibrary` 新增 `export_package` 与 `preview`，并新增试用执行器 seam。

1、export 把当前 current 版本重建为 `SKILL.md`（重新写入 name/description frontmatter）与 `references/`、`assets/` 包文件，只写包自身数据；导出包经过同一套校验可由另一个 Owner 原样重新导入。
2、preview 在管理侧验证 Owner、联系人范围、Skill active 状态和当前版本后，把单一 Skill 目录交给 `SkillPreviewEngine` 执行；`ReplySkillPreviewEngine` 通过 `SingleSkillCatalogPort` 强制只加载该 Skill，并映射可编辑候选与 Skill 版本/选择原因/资源加载状态。
3、试用既不写记忆、也不创建或修改 Skill 版本/状态/`skill_library_revision`；Skill 不可用或引擎失败时返回不含正文与路径的无 Skill 受控预览。
4、真实验证：新增 export 集成测试 3 个、preview 管理集成测试 4 个、preview 执行器单元测试 3 个全部通过；全仓 468 个测试通过、2 个跳过，`git diff --check` 干净。

