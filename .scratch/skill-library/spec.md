# Skill Library（Skill 库）规格

Type: task
State: resolved
Triage: ready-for-agent

## Problem Statement

用户有一批在项目外清洗的中文视频教学语料，希望把其中可复用的回复规则、步骤、好回复、反例和边界案例转化为 NotAlone 可以稳定使用的回复策略。

当前项目已经有 Reply Skill 的只读目录和版本读取能力，但还没有完整的 Skill Library 管理模块。缺少统一的导入、校验、辅助资源、版本、启停、删除、导出和试用流程，会造成以下问题：

- 教学规则可能与 Style Sample、联系人事实或关系记忆混在一起；
- Skill 内容无法经过完整校验后原子发布；
- 更新可能覆盖旧策略，无法回滚或解释某次回复使用的版本；
- 长说明和更多案例无法按需加载，容易把所有内容塞进候选回复上下文；
- 用户无法知道本次候选回复是否使用了哪一个 Skill；
- 删除 Skill 后可能残留正文、辅助资源、目录缓存或运行状态；
- Skill 管理逻辑可能侵入 Retrieval、ReplyContext、Reply Runtime 或外部发送能力。

## Solution

建立独立的 Skill Library 模块，管理当前 Owner 可用的 Reply Skill。每个 Reply Skill 只代表一种回复策略，不是联系人事实、关系记忆、Style Sample 或 Tool。

特定视频教学语料在项目外完成转写、清洗和归纳。进入 NotAlone 的产物是用户明确选择的本地 Skill 包：

    reply-skill/
    ├── SKILL.md
    ├── references/
    └── assets/

SKILL.md 是必需文件，使用官方 Agent Skills 的 name、description 和 Markdown 正文约定。references 用于较长的规则和案例，assets 用于受控静态模板或素材；它们与一个不可变版本绑定并按需只读加载。scripts 不进入 NotAlone v1 的可运行能力。

Skill Library 分为两个接口面：

1. SkillLibraryManagementPort：供用户明确触发导入、更新、启停、删除、导出和试用。
2. SkillPort：供 Reply Runtime 只读发现目录、加载一个版本和读取该版本允许的辅助资源。

回复运行时先验证 Owner、Contact 和桌面会话范围，再由 Retrieval 和 ReplyContext 组装当前联系人上下文；随后通过目录元数据选择零个或一个 Skill，按需加载内容，生成可编辑候选。Skill 选择失败或加载失败时退回无 Skill 路径。最终消息仍由用户编辑并亲自发送。

本规格是多阶段实现的入口。它保持现有 Reply、Retrieval、ReplyContext、关系记忆和人工发送边界，不把架构设计误称为已经实现的端到端能力。

## User Stories

1. 作为用户（Owner），我想拥有一个独立的 Skill Library，以便集中管理我可以使用的回复策略。
2. 作为用户（Owner），我想让每个 Reply Skill 只代表一种策略，以便知道每次回复采用的具体套路。
3. 作为用户（Owner），我想把视频教学清洗成 Skill 包，以便把教学中的规则和案例转化为可复用能力。
4. 作为用户（Owner），我想让原始教学视频留在项目外，以便不把大型原始媒体和无关隐私带入 NotAlone。
5. 作为用户（Owner），我想让好回复、坏回复和边界案例可以写入 Skill，以便模型理解规则的具体表现。
6. 作为用户（Owner），我想让教学规则和我的个人 Style Sample 分开，以便策略资料不会被误认为是我的真实表达样本。
7. 作为用户（Owner），我想让 Skill 使用官方兼容的 SKILL.md 格式，以便未来可以迁移和复用 Skill 包。
8. 作为用户（Owner），我想只需要提供 name 和 description 等必要元数据，以便正文可以按教学内容灵活组织。
9. 作为用户（Owner），我想在 Skill 中写适用场景、回复步骤、示例和禁忌，以便系统知道何时以及如何使用它。
10. 作为用户（Owner），我想把较长的规则和更多案例放入 references，以便核心 Skill 正文保持清晰且按需加载。
11. 作为用户（Owner），我想让受控静态模板放入 assets，以便策略可以引用必要的固定结构。
12. 作为用户（Owner），我想让 scripts 不获得执行能力，以便 Skill 不能访问文件、网络或聊天发送能力。
13. 作为用户（Owner），我想明确选择本地 Skill 包后再导入，以便没有隐藏的自动下载和安装。
14. 作为用户（Owner），我想在导入时得到格式、安全、隐私和质量校验，以便不合格的策略不会直接进入回复流程。
15. 作为用户（Owner），我想让路径遍历、符号链接逃逸、非法资源类型和超大文件被拒绝，以便 Skill 包不能扩大读取范围。
16. 作为用户（Owner），我想让 SKILL.md 和所有辅助资源一起通过校验后再发布，以便库中不会出现半成品 Skill。
17. 作为用户（Owner），我想让通过校验的第一个版本直接启用，以便导入后可以立即试用。
18. 作为用户（Owner），我想让同一 Owner 下的 Skill 名称唯一，以便目录推荐和人工选择不会产生歧义。
19. 作为用户（Owner），我想让同名导入不能静默覆盖旧 Skill，以便明确区分新建和更新。
20. 作为用户（Owner），我想让更新创建不可变新版本，以便历史回复仍能关联当时实际使用的策略。
21. 作为用户（Owner），我想保留旧版本并支持回滚，以便新策略效果不好时可以恢复旧策略。
22. 作为用户（Owner），我想启用或停用 Skill，以便控制它是否出现在后续回复的可用目录中。
23. 作为用户（Owner），我想删除 Skill 时清除正文、辅助资源和来源定位，以便删除后的策略不能被恢复。
24. 作为用户（Owner），我想让删除后只保留最小删除凭证，以便保留审计关联的同时不留下可恢复内容。
25. 作为用户（Owner），我想导出可移植 Skill 包，以便在不同环境之间迁移策略，而不带走联系人和聊天资料。
26. 作为用户（Owner），我想在选定 Reply Task 上试用 Skill，以便在正式使用前观察它生成的候选效果。
27. 作为用户（Owner），我想让试用只生成应用内预览，以便试用不会发送消息、修改记忆或改变长期偏好。
28. 作为用户（Owner），我想让 Owner 全局 Skill 对我所有联系人可用，以便不必为每位联系人重复导入相同策略。
29. 作为用户（Owner），我想让不同 Owner 的 Skill 完全隔离，以便我的策略不会泄漏给其他用户。
30. 作为用户（Owner），我想让系统可以根据 Skill 的目录元数据推荐策略，以便我不必每次记忆 Skill ID。
31. 作为用户（Owner），我想在每次回复中关闭或改选推荐的 Skill，以便保留对当前回复的控制。
32. 作为用户（Owner），我想让一次回复最多加载一个 Skill，也可以不加载，以便候选回复的策略来源清晰可解释。
33. 作为用户（Owner），我想看到当前候选回复实际使用的 Skill 名称和版本，以便知道策略是否参与了生成。
34. 作为用户（Owner），我想看到 Skill 的选择原因和加载状态，以便发现不合适的推荐或资源读取失败。
35. 作为用户（Owner），我想让 Skill 只能读取当前已验证联系人的 ReplyContext，以便策略不会访问其他联系人或未授权数据。
36. 作为用户（Owner），我想让 Skill 不能直接执行 Retrieval，以便联系人资料检索仍由独立模块负责。
37. 作为用户（Owner），我想让联系人事实优先于 Skill 的表达策略，以便策略不会覆盖已确认的关系资料。
38. 作为用户（Owner），我想让当前用户要求和产品安全边界优先于 Skill，以便不可信文本不能改变本次请求的权限。
39. 作为用户（Owner），我想让 Skill 不能自动变成长期偏好或关系记忆，以便一次性策略不会静默改变产品行为。
40. 作为用户（Owner），我想让 Skill 加载失败后继续走无 Skill 回复路径，以便一个策略故障不会阻断候选回复。
41. 作为开发者，我想通过 SkillLibraryManagementPort 测试管理行为，以便校验、版本和删除规则集中在一个高层接口。
42. 作为开发者，我想通过 SkillPort 和 Reply Runtime 测试运行行为，以便不依赖具体数据库查询或框架内部状态。
43. 作为开发者，我想让 Skill Library 更新时递增 Owner 级 skill_library_revision，以便所有联系人范围的旧目录缓存失效。
44. 作为开发者，我想让运行记录保存 skill_version_id、选择原因、目录修订和已加载资源路径，以便复现本次使用的策略范围。
45. 作为开发者，我想让测试只使用合成 Owner、Contact、Reply Task 和 Skill，以便真实聊天资料不进入测试和 Git。

## Implementation Decisions

1. **模块归属**
   - Skill Library 是独立 Module。
   - Reply Skill 只表示回复策略；Style Sample、Relationship Memory、Retrieval、ReplyContext 和 Reply Runtime 保持独立。
   - Skill Library 不负责联系人识别、会话绑定、资料检索、关系记忆、候选生成或外部发送。

2. **测试 Seam**
   - 管理侧的最高 Seam 是 SkillLibraryManagementPort，覆盖本地包导入、校验、原子发布、更新、启停、删除、导出和试用。
   - 运行侧沿用现有 SkillPort 和 Reply Runtime Seam，覆盖目录发现、版本加载、资源读取、范围隔离和无 Skill 回退。
   - 不新增一个把管理、检索、上下文和生成全部合并的浅 Module。

3. **Owner 与范围**
   - Skill 的归属键是 Owner。
   - v1 用户导入的 Skill 默认是 Owner 全局 Skill，对该 Owner 的所有 Contact 可用；不跨 Owner 共享。
   - 运行时仍必须使用已验证的 owner_id + contact_id scope，不能由模型提供或修改范围。

4. **Skill 包格式**
   - 一个包必须包含 SKILL.md；可选包含 references 和受控 assets。
   - SKILL.md 的 name 必须与目录名一致，使用官方允许的小写名称格式；description 必须说明用途和使用时机。
   - 正文不强制固定标题，但建议包含适用场景、核心规则、操作步骤、正反例、边界和禁忌。
   - references 用于按需读取的长说明、规则和案例；assets 用于按需读取的静态模板或允许的静态素材。
   - scripts 不进入 v1 可运行版本；包中出现不支持的可执行内容时拒绝发布或要求移除后重新导入。
   - allowed-tools 等文本声明不产生任何权限。

5. **导入与校验**
   - v1 只接受用户明确选择的本地包；候选回复 Agent 不能自行搜索、下载、更新、启用或删除 Skill。
   - 校验覆盖目录结构、frontmatter、名称、描述、编码、大小、路径、符号链接、资源类型、内容哈希、隐私和指令安全。
   - 校验必须拒绝路径遍历、符号链接逃逸、外部 URL 运行时依赖、联系人隐私、聊天原文、原始教学视频和越权能力声明。
   - SKILL.md 应保持在约 500 行、5000 tokens 以内；references 和 assets 受单次加载预算限制；超限不自动截断。
   - 质量问题可以产生用户可见警告；结构或安全问题必须阻止发布。
   - 所有文件校验通过后才在一个事务中创建目录项、不可变版本和资源记录。

6. **版本与生命周期**
   - 第一个有效版本直接成为 current 和 active，不建立项目内 SkillDraft。
   - 同一 Owner 下名称唯一；明确执行 update 才能使用相同名称创建新版本，普通重复 import 必须要求改名或再次确认。
   - 更新始终创建不可变版本；新版本校验通过后成为 current 和 active，旧版本保留并支持回滚。
   - enable、disable、import、update 和 delete 都必须在同一事务中递增 Owner 级 skill_library_revision。
   - 删除清除所有版本正文、辅助资源、来源定位、目录缓存、运行状态、Skill Tool 结果和包含旧正文的摘要，只保留最小删除凭证。

7. **管理接口**
   - SkillLibraryManagementPort 的调用者是用户明确操作的管理入口，不是模型。
   - 管理行为包括 import package、update package、enable、disable、delete、export 和 preview。
   - 管理接口负责用户权限、Owner 归属、同名规则、完整校验、原子发布、版本切换、删除和结果说明。
   - export 只导出可移植 Skill 包和必要包元数据，不导出 Contact、聊天记录、Reply Task、候选、Relationship Memory 或使用日志。
   - preview 只生成应用内候选预览，不发送消息、不创建 Style Sample、不写入 Relationship Memory。

8. **运行接口**
   - SkillPort 对 Reply Runtime 暴露框架无关的只读能力：读取当前范围目录、按版本加载不可变 Skill，以及读取该版本允许的辅助资源。
   - 目录只显示当前 scope 下已启用的元数据；完整正文和辅助资源采用 progressive disclosure。
   - 每个读取动作都重新校验 Owner、Contact scope、Skill 状态、当前版本、目录修订、资源路径和资源归属。
   - 读取路径只能是目录中列出的 SKILL.md 或允许的包内相对资源路径，不能读取任意服务器文件、其他 Owner、其他 Contact 或外部 URL。
   - SkillsMiddleware 只是运行时 Adapter，不拥有 Skill Library 生命周期，也不能获得通用文件系统、Shell、网络或发送能力。

9. **候选回复集成**
   - 候选流程先 validate_scope、assess_request_risk，再由 Retrieval 和 ReplyContext 组装当前 Contact 的上下文。
   - SkillPort 发现 name、description、状态和版本等元数据后，系统或用户选择零个或一个 Skill。
   - 选择 Skill 后按需加载 SKILL.md，只有必要时才加载 references 或 assets。
   - 本次最多加载一个 Skill；没有合适 Skill、用户关闭 Skill、目录为空或加载失败时继续无 Skill 路径。
   - Reply Runtime 记录实际使用的 skill_version_id、选择方式、选择原因、目录修订、资源路径和加载状态。
   - UI 显示实际使用的 Skill 和版本，并允许用户关闭或更换；最终候选仍需用户编辑并亲自发送。

10. **作用优先级与安全**
    - 产品安全、权限和联系人隔离约束优先于所有 Skill 文本。
    - 用户本次明确要求和手动选择优先于 Skill 策略。
    - 已确认 Contact 事实不能被 Skill 覆盖。
    - Skill 只决定当前回复的表达策略，不能写入 Relationship Memory、长期偏好、系统设置或出站渠道。
    - Skill 不能注册或扩大 Tool、MCP、Shell、网络、文件写入、Subagent 或聊天发送能力。

11. **数据模型**
    - Skill Library 保存 Owner 级 skill_library_revision。
    - reply_skill 保存名称、Owner 归属、描述、状态和当前版本；v1 用户导入的 Skill 默认 Owner 全局适用。
    - reply_skill_version 保存不可变 SKILL.md 正文、版本号、来源定位、内容哈希和校验结果。
    - reply_skill_resource 保存版本绑定的相对路径、媒体类型、大小、内容哈希和受控内容定位。
    - Reply Task 保存实际使用的 Skill 版本、选择原因、目录修订、使用状态和资源读取摘要。
    - PostgreSQL 是 Skill 目录、版本、资源元数据、状态和删除状态的权威库；运行时 Adapter 只提供受控视图。

12. **故障与缓存**
    - Skill 目录缓存绑定 owner_id + contact_id + skill_library_revision。
    - Owner 的任一 Skill 导入、更新、启用、停用或删除后，旧目录、旧资源结果、旧 Skill Tool 结果和旧摘要失效。
    - 版本不一致、scope 不一致、资源不存在、内容已删除或读取失败时返回受控错误，并退回无 Skill 路径。
    - 运行日志只记录 Skill 和版本等非正文元数据，不保存完整 Prompt、Skill 正文或聊天原文。

13. **当前实现关系**
    - 当前仓库已有 Skill 领域对象、只读 PostgreSQL SkillPort、Owner 级目录修订和候选回复运行时 Adapter。
    - 本规格新增的管理接口、辅助资源持久化、资源读取、包校验、导出和试用仍需要实现。
    - 架构文档描述目标约束，不证明管理链路、资源链路或端到端 Skill 导入已经可运行。

## Testing Decisions

1. **外部行为优先**
   - 好的测试从公开 Interface 观察目录、导入结果、版本、状态、错误、回退和删除结果，不断言私有函数、SQL 拼接、框架内部 middleware 状态或调用顺序。
   - 所有失败都必须检查错误不泄漏 SQL、路径、联系人名称、聊天正文、Skill 正文或其他 Owner 的存在性。

2. **管理 Seam**
   - 通过 SkillLibraryManagementPort 验证正常本地包导入、损坏 frontmatter、名称不匹配、重复名称、非法路径、符号链接、非法资源、超限内容和脚本拒绝。
   - 验证 SKILL.md 与全部资源必须一起通过校验；任何失败都不能留下可运行的目录项、版本或资源。
   - 验证首个版本自动启用；更新产生新版本、旧版本可回滚；停用版本不可进入目录；删除后正文、资源和来源不可恢复。
   - 验证导出不含 Owner 之外的联系人资料、聊天、候选、记忆或使用日志；试用不发送、不写入长期资料。

3. **运行 Seam**
   - 通过现有 SkillPort 和 Reply Runtime 验证 Owner 全局目录、联系人范围、revision、版本加载、辅助资源按需读取和每次最多一个 Skill。
   - 验证目录只暴露 name、description 等元数据；未选择 Skill 时不加载正文；选中后才按需读取正文和资源。
   - 验证资源路径不能跳出包目录，不能读取其他 Owner、其他 Contact、任意服务器文件或外部 URL。
   - 验证 Skill 加载失败、版本失效、revision 不一致和资源读取失败时继续无 Skill 候选路径。
   - 验证候选记录实际 skill_version_id、选择原因、目录修订、资源摘要和失败状态；最终没有发送 Tool。

4. **数据库与隔离**
   - 使用合成 Owner、Contact、Reply Task、Skill 和资源验证 PostgreSQL 事务、唯一名称、不可变版本、资源归属和删除级联。
   - 使用两个 Owner 和两个 Contact 验证目录、版本、资源、缓存和运行状态不串范围。
   - 使用并发或重复导入验证原子发布和同名更新不会产生两个 current 版本或半成品资源。
   - 迁移测试只验证已决定的数据约束，不用测试旁路替代 ManagementPort 或 SkillPort 的外部行为。

5. **运行预算与质量**
   - 验证 SKILL.md 行数和 token 预算、references/assets 单次加载预算、超限拒绝或提示、引用深度和不自动截断。
   - 验证质量警告不会绕过结构和安全硬校验；安全失败不会成为 active 版本。
   - 运行测试使用合成策略和匿名示例，不使用真实教学视频或真实聊天资料。

6. **现有测试先例**
   - 复用现有 Skill 模型单元测试的不可变对象、Owner/Contact 隔离和版本一致性模式。
   - 复用现有 PostgreSQL SkillPort 集成测试的随机 Owner、合成 Skill、真实数据库约束和空目录模式。
   - 复用现有候选回复运行时测试的 fake model、结构化候选、Skill 使用记录、revision 不一致和无外部发送断言。
   - 完整实现后运行最小相关 unit/integration 测试、编译检查和 git diff --check；不把未配置的真实模型或真实网络安装当作默认测试。

## Out of Scope

- 原始教学视频在 NotAlone 内的上传、转写、清洗、标注、切片和质量评估流水线。
- Style Sample 的保存范围、采纳入口、权重和联系人级生命周期。
- Relationship Memory、Retrieval、ReplyContext 的重新设计或替换。
- Skill scripts 的执行、Tool/MCP 扩展、Shell、Subagent、网络运行时资源和外部 URL 读取。
- 跨 Owner 共享 Skill、公共 Skill 市场和模型自动生成公共 Skill。
- 候选回复自动发送、聊天渠道写入和后台代替用户发送。
- 候选回复采纳后自动创建、更新、启用或改写 Skill。
- 在没有独立授权和新架构决策前支持网络 Skill 安装。
- 本规格之外的 PostgreSQL ReplyStore、桌面同步、OCR 或关系分析任务实现。

## Further Notes

- 本规格与 [Skill Library 现行设计](../../architecture/current/skill-library.md) 和 [ADR-019](../../architecture/adr/019-controlled-reply-skill-resources.md) 对齐；ADR-019 修订了 ADR-010 关于 v1 supporting files 的旧限制。
- 官方格式依据：[Agent Skills 规范](https://agentskills.io/specification)、[LangChain Skills](https://docs.langchain.com/oss/python/langchain/multi-agent/skills)、[Deep Agents Skills](https://docs.langchain.com/oss/python/deepagents/skills)。
- 该功能适合按多会话实现：先建立包校验和不可变发布，再建立资源存储与运行时读取，最后补齐管理展示、导出和试用。
- 实现任何随版本变化的 LangChain、Deep Agents 或 LangGraph 接口前，必须先核对官方文档、项目锁定版本和实际安装版本；文档证明接口约定，代码和测试才证明集成可用。
- 发布本规格不代表管理接口、辅助资源链路或真实 Skill 导入已经实现。

## Comments

- 2026-10-04：收尾核验后关闭。5 张 issue 均已 resolved；管理端口与实现（`skills/ports.py`、`persistence/skill_library.py`）、包校验与隐私检查（`skills/package.py`、`package_reader.py`）、服务端 Skill API（`server/app.py`）、运行期使用记录（`reply/interface.py`、迁移 024）均可核对，单测 `tests/unit/skills` 8 项与 `tests/unit/reply` 128 项通过。spec 文本里“仍需实现”的段落已过期。
- 2026-10-04：如实保留三处非阻塞缺口，不在本规格内继续：①运行时辅助资源没有“单次加载预算／超限不截断”的实现与测试（`reply/adapters/langchain_runtime.py` 只记 `loaded_resources` 与 `load_state`，资源全文返回），其额度与超限行为需要用户先给数值；②500 行／5000 token／1MB／4MB 预算只有实现、无单测；③桌面 App 无回滚入口、服务端无 update/export 端点。①如需落地，建议另立任务并明确是否修订 ADR-019。
