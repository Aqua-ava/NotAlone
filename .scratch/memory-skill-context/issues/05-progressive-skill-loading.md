# 05 — Skill 目录与按需加载

**What to build:** 用户生成候选回复时，系统先提供可用 Skill 的轻量目录；用户或模型可以选择一个策略，系统再按需加载对应的不可变版本和受控辅助资源。没有匹配或加载失败时，回复仍使用默认策略。

**Blocked by:** 03 — Skill 必须嵌入已验证的 ReplyContext 和候选回复入口。

**Status:** ready-for-agent
**State:** resolved
**Triage:** ready-for-agent

- [x] 目录只包含名称、描述、适用场景、状态和版本等轻量元数据，可以作为会话级稳定内容缓存。
- [x] 用户明确选择优先；自动选择最多使用一个 Skill，也可以不使用。
- [x] 选中的 Skill 只加载一个经过校验的不可变版本，记录版本和选择原因。
- [x] references/assets 只能按当前版本的受控相对路径按需读取；脚本、任意文件、网络、Tool/MCP 和外部发送能力均被拒绝。
- [x] Skill 只能影响本次回复策略，不能写 Memory、修改权限、读取其他联系人或改变发送边界。
- [x] 目录、版本或联系人范围变化后，相关缓存和旧运行状态失效。
- [x] 没有匹配、目录失败、版本不一致或 Resource 读取失败时，系统回退到无 Skill 策略。
- [x] 候选结果可追踪实际使用的 Skill 和版本，且使用现有 Skill Library 的管理和读取契约。

## Answer

已完成 Skill 目录与按需加载：

1. `SkillCatalogEntry` 只保存名称、描述、适用场景、active 状态和版本号等轻量元数据；Reply Runtime 使用绑定 `ContactScope + skill_library_revision` 的缓存，联系人或 revision 变化时不会复用旧目录。
2. `AutoSkill` 最多允许一个已校验版本，`UserSkillChoice` 会先锁定当前范围内的指定版本，并在成功加载时记录 `selection_method` 和选择原因；版本正文及 references/assets 继续通过现有 `SkillPort` 的不可变、相对路径和联系人范围校验读取。
3. 脚本、任意路径、网络、Tool/MCP、自定义发送和管理接口不进入运行时；资源或版本加载失败、目录故障、revision 不一致时都不产生 `used_skill`，继续使用默认候选路径。

验证：Skill 相关单元测试 26 个、LangChain Reply 纵切与统一输入测试 17 个通过；新增用户选择、目录缓存、轻量目录元数据和资源失败无 Skill 回退测试。未增加 Memory 写入、权限修改或外部发送能力。
