# 05 — Skill 导出与试用预览

Type: task

**Triage:** ready-for-agent
**State:** open

**What to build:** 用户可以导出一个可移植的 Skill 包，也可以在选定的 Reply Task 上试用指定 Skill；导出不带走联系人资料，试用只生成应用内候选预览，不改变长期数据或发送消息。

**Blocked by:** 01、02 — 导出需要已发布的版本和资源，试用需要 Reply Runtime 的受控加载能力。

- [ ] 导出能够重建合法的 `SKILL.md`、允许的 `references/`、`assets/` 和必要包元数据，并保持版本内容与校验结果一致。
- [ ] 导出只包含 Skill 包自身数据，不包含其他 Owner、Contact、聊天记录、Reply Task、候选回复、Relationship Memory、Style Sample 或使用日志。
- [ ] 试用前验证 Owner、已确认 Contact、选定 Reply Task 和 Skill 版本范围；试用只允许使用当前 Reply Context 和受控 Skill 资源。
- [ ] 试用返回可编辑的候选预览，并展示实际 Skill、版本、选择原因、资源加载状态或失败回退原因；不发送外部消息。
- [ ] 试用不创建或修改 Relationship Memory、Style Sample、长期偏好、Skill 版本、Skill 状态或 `skill_library_revision`。
- [ ] 试用中的 Skill 或资源加载失败时返回无 Skill 预览或受控错误，不泄漏路径、聊天正文、其他 Owner 数据或 Skill 私密正文。
- [ ] 使用合成 Skill、Owner、Contact 和 Reply Task 覆盖导出完整性、资料排除、试用成功、试用回退、无持久化副作用和人工发送边界。

## Comments

- 来源规格：`.scratch/skill-library/spec.md`。
- 网络安装、自动导出、自动发送和视频清洗流程不在本票范围内。
