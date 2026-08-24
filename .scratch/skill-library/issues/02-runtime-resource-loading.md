# 02 — Reply Runtime 渐进式加载 Skill 辅助资源

Type: task

**Triage:** resolved
**State:** resolved

**What to build:** Reply Runtime 通过现有 `SkillPort` 只读发现当前范围内已启用的 Skill，并在用户或系统选择后按需加载一个 Skill 及其受控辅助资源；没有合适 Skill 或加载失败时，候选回复继续走无 Skill 路径。

**Blocked by:** 01 — Skill 包必须先能够经过校验并以版本和资源记录原子发布。

- [x] 目录只返回已验证 `owner_id + contact_id` 范围内的已启用元数据；默认不返回 Skill 正文、聊天资料或任意服务器路径。
- [x] 没有选择 Skill 时不加载 `SKILL.md`；选择后先加载对应不可变版本的正文，只有必要时才按需读取该版本列出的 `references/` 或 `assets/`。
- [x] 每次读取都校验 Owner、联系人范围、Skill 状态、版本、`skill_library_revision`、资源归属和包内相对路径；不能读取其他 Owner、其他 Contact、包外文件或外部 URL。
- [x] 一次候选回复最多加载一个 Skill，也允许明确不加载；Skill 不能自行触发 Retrieval、Tool、MCP、Shell、网络、文件写入或消息发送。
- [x] 目录过期、版本失效、资源不存在或读取失败时，丢弃本次 Skill 内容并继续生成无 Skill 候选，不使用部分或未验证内容。
- [x] 运行结果记录实际使用的 Skill 版本、选择方式、选择原因、目录修订、已加载资源路径和加载状态；不记录完整 Prompt、聊天原文或 Skill 正文。
- [x] 候选结果能向用户说明实际使用的 Skill、版本和加载状态，且现有人工编辑与手动发送边界保持不变。
- [x] 使用 fake model、合成 Owner/Contact/Reply Task 和 PostgreSQL 覆盖元数据目录、按需读取、路径越界、联系人隔离、最多一个 Skill、失败回退和无外部发送。

## Comments

- 来源规格：`.scratch/skill-library/spec.md`。
- 本票不新增联系人识别、Retrieval、ReplyContext 或 Style Sample 逻辑；Skill 只消费已验证的当前 Reply Context。

## Answer

已完成 Ticket 02：Reply Runtime 现在可以按需读取一个已选中 Skill 的 `SKILL.md` 以及该不可变版本列出的受控 `references/` / `assets/` 辅助资源。

1、`SkillPort` 新增 `load_resource(scope, version_id, relative_path)`；`PostgresSkillPort.load_version` 返回版本允许的 `resource_paths`，`load_resource` 在同一事务中校验 Owner、联系人、当前 active/enabled 版本、资源归属和包内相对路径，越权、路径越界、缺失或外部资源统一安全失败。
2、运行时 `read_file` 工具按 `SKILL.md` 或 `references/` / `assets/` 资源路径渐进式读取，并沿用 `SkillLoadBudget`：一次最多加载一个 Skill 版本，跨版本读取/第二条 Skill 会硬性中止；目录过期、目录读取失败、版本失效和资源读取失败时丢弃 Skill 内容并继续走无 Skill 候选路径。
3、`SkillUse` 扩展记录选择方式、选择原因、已加载资源路径和加载状态；migration 024 新增 `reply_request` 的四个非正文审计列并写入/读回。
4、真实验证：`python -m unittest discover -s tests` 全仓 437 个测试通过、2 个跳过，`git diff --check` 干净；新增长案/路径越界/联系人隔离/失败回退/无外发单元测试与 PostgreSQL 资源读取集成测试。

