# ADR-019：回复 Skill 的受控辅助资源

> 状态：已采纳
> 日期：2026-08-24
> 修订：ADR-010 关于 v1 不挂载 supporting files 的部分约束

现有 ADR-010 将 v1 限定为只持久化和暴露 SKILL.md。后续 Skill Library 设计确认：清洗后的教学规则、长说明和更多案例需要放在 references，必要的静态模板需要放在 assets；这些内容可以提高 Skill 的可复用性，但不能引入脚本或新的执行权限。

## 决策

1. Skill 包必须包含 SKILL.md，可选包含 references 和受控的 assets。SKILL.md 保存核心策略；辅助资源与一个不可变 reply_skill_version 绑定，记录相对路径、类型、大小和内容哈希。
2. v1 只接受用户明确选择的本地 Skill 包。导入器必须完整校验包结构、frontmatter、路径、大小、资源类型、隐私和指令安全；所有文件通过后才原子发布。包含 scripts 或其他不支持的可执行内容不能进入 active 版本。
3. 运行时使用渐进式加载：先发现 name 和 description，再按需读取 SKILL.md，只有当前 Skill 确实需要时才读取受控 references 或 assets。资源读取沿用 owner_id + contact_id + skill_library_revision 和不可变版本校验，不能退化为任意文件读取或外部 URL 下载。
4. Skill 仍然最多每次回复加载一个，也可以不加载。辅助资源只提供策略文本或静态素材，不能注册 Tool、MCP、Shell、网络、文件写入或聊天发送能力。
5. 删除 Skill 时清除所有版本正文、辅助资源、来源定位和运行缓存，只保留最小删除凭证。历史请求可以保留版本关联，但不能恢复已删除内容。

## 取舍

- 只支持 SKILL.md 会让长教学材料挤进核心提示词，降低渐进式加载的价值。
- 完整支持脚本和任意外部资源会扩大文件、网络和执行风险，与 NotAlone 的联系人隔离和人工发送边界冲突。
- 受控 references/assets 在保留官方包结构兼容性的同时，把可执行能力留在 NotAlone 的确定性权限系统之外。

## 后果

- Skill Library 需要资源版本记录、完整包校验、原子发布和资源删除；现有只读 SkillPort 和 runtime Adapter 需要扩展受控资源读取。
- architecture/current/skill-library.md 成为 Skill 包、管理接口、运行流程和资源生命周期的现行规格；隐私、删除和候选流程文档只保留跨模块约束并链接到该规格。
- ADR-010 关于 create_agent、SkillsMiddleware、单 Skill、只读读取、缓存 revision 和禁止扩权的决定继续有效；仅其“v1 不下载或挂载 references/assets”的部分由本 ADR 修订。

## 官方依据

- [Agent Skills 规范](https://agentskills.io/specification)
- [LangChain Skills](https://docs.langchain.com/oss/python/langchain/multi-agent/skills)
- [Deep Agents Skills](https://docs.langchain.com/oss/python/deepagents/skills)
- [SkillsMiddleware API](https://reference.langchain.com/python/deepagents/middleware/skills/SkillsMiddleware)
