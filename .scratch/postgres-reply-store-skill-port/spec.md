# PostgreSQL ReplyStore 与 SkillPort 已确认规格

Type: task
State: open
Triage: ready-for-agent
Implementation: paused; do not modify or predefine the memory or reply-context Modules

## Problem Statement

用户已经围绕 PostgreSQL `ReplyStore`、`SkillPort`、候选继续、幂等、会话绑定和回复 Skill 生命周期作出了一批决定，但这些决定分散在聊天和架构文档中，容易因聊天丢失而失去上下文。

当前正式候选回复纵切只使用合成数据和内存 adapter。`ReplyStore` 还没有 PostgreSQL 实现，并且现有内部 Interface 把“回复持久化”和“回复上下文组装”放在同一个 `prepare` 操作中。用户正在单独设计记忆 Module 和回复上下文 Module，明确要求本工作不得修改、替代或预先规定这两个 Module；如果 PostgreSQL `ReplyStore` 无法在不碰它们的情况下完成，就先暂停实现。

`SkillPort` 已经有独立的只读 Interface，但还没有 PostgreSQL adapter。会话绑定也只有领域定义，没有正式的最小 PostgreSQL 记录可供回复流程重新验证联系人。

## Solution

先把已确认的设计固定为本规格，不继续编写 PostgreSQL `ReplyStore`。以后恢复实现时，`ReplyStore` 只承担一次候选回复任务的数据库持久化、幂等状态、重放和候选保存，不选择回复上下文、不读写关系记忆、不执行 OCR、不调用模型，也不发送微信消息。

`SkillPort` 保持独立且只读，只向回复运行时提供当前联系人范围可见的 Skill 目录与不可变版本。Skill 创建、安装、更新、启用、禁用和删除属于后续 Skill 管理工作，不进入本规格的 adapter Interface。

建立最小 `conversation_binding` 数据模型，用于证明当前桌面会话已经由用户确认并绑定到一个 `owner_id + contact_id`。OCR 如何发现当前窗口联系人属于后续桌面同步工作；本规格只保留会话绑定的验证需求。

本规格的 `ready-for-agent` 表示已确认内容已经整理完成，可以被后续 Agent 读取和拆分；它不解除 PostgreSQL `ReplyStore` 的暂停门槛。用户明确恢复工作前，不得据此修改记忆 Module、回复上下文 Module 或继续实现 PostgreSQL `ReplyStore`。

## User Stories

1. As a NotAlone 用户, I want 已确认的 ReplyStore 与 SkillPort 决定被记录在仓库中, so that 聊天丢失后仍能恢复设计上下文
2. As a NotAlone 用户, I want ReplyStore 只负责保存回复任务, so that 它不会替我的上下文 Module 决定模型应该看到什么
3. As a NotAlone 用户, I want ReplyStore 不读取或修改关系记忆, so that 我的记忆 Module 可以独立设计和演进
4. As a NotAlone 用户, I want 一次已完成的相同请求直接返回原候选, so that 重试不会再次调用模型或产生重复候选
5. As a NotAlone 用户, I want 相同幂等键但不同输入被明确拒绝, so that 一个请求身份不会代表两次不同回复
6. As a NotAlone 用户, I want 正在运行的重复请求显示为处理中, so that 两个并发请求不会同时生成候选
7. As a NotAlone 用户, I want 失败或租约过期的请求可以用同一请求身份重试, so that 临时故障不会迫使我创建重复任务
8. As a NotAlone 用户, I want 只有我明确选择历史候选时才继续该候选, so that 系统不会擅自把最近候选带进新回复
9. As a NotAlone 用户, I want 继续候选时再次验证联系人和会话范围, so that 其他联系人的候选不会进入当前回复
10. As a NotAlone 用户, I want 当前桌面会话绑定到一个已确认联系人, so that 每次回复都能重新验证我正在和谁聊天
11. As a NotAlone 用户, I want 重名、会话变化或低置信识别要求我确认, so that OCR 不会静默选错联系人
12. As a NotAlone 用户, I want SkillPort 只列出当前 owner 和联系人可用的 Skill, so that 其他联系人或用户的策略不会泄漏
13. As a NotAlone 用户, I want SkillPort 按不可变版本读取正文, so that 一次回复实际使用的策略可以被准确记录
14. As a NotAlone 用户, I want 每次回复最多使用一个 Skill 版本, so that 我能理解本次采用了哪一种回复策略
15. As a NotAlone 用户, I want Skill 目录拥有 owner 级修订号, so that 任一 Skill 变化后旧目录缓存都会失效
16. As a NotAlone 用户, I want 同一 owner 下的 Skill 名称唯一, so that 自动选择和人工选择不会遇到同名歧义
17. As a NotAlone 用户, I want 回复记录保存 Skill 是自动选择还是人工选择, so that 我能回看策略是怎样进入本次回复的
18. As a NotAlone 用户, I want 回复记录保存简短的 Skill 选择原因且允许置信度为空, so that 系统不会把不可靠的模型分数伪装成精确判断
19. As a NotAlone 用户, I want 删除 Skill 时清除所有版本正文和来源定位, so that 已删除策略不能从历史状态中恢复
20. As a NotAlone 用户, I want 删除 Skill 后只保留最小删除记录, so that 历史回复还能说明曾使用哪个版本而不会保留可恢复正文
21. As a NotAlone 用户, I want 所有验证只使用合成联系人、消息和 Skill, so that 私人聊天资料不会进入测试、日志或 Git
22. As a NotAlone 用户, I want 候选始终只在 NotAlone 中展示并由我亲自发送, so that ReplyStore 或 SkillPort 不会获得外部聊天发送能力

## Implementation Decisions

1. **当前实施状态**
   - 本次只发布规格，不实现代码或数据库迁移。
   - PostgreSQL `ReplyStore` 当前暂停。只有在能够保证不修改、不替代也不预先规定记忆 Module 和回复上下文 Module，并且用户明确恢复工作后，才可以继续。
   - 不新增临时的上下文选择 Interface，不实现目标消息、近期消息或关系记忆的选择规则，也不以占位逻辑替代用户正在设计的两个 Module。

2. **Module 职责**
   - `ReplyStore` 的含义固定为候选回复任务的数据库持久化层。
   - 它负责请求身份、幂等状态、运行状态、候选保存、已完成结果重放，以及持久化失败时不返回候选。
   - 它不负责回复上下文选择、关系记忆、OCR、模型生成、Skill 选择算法或外部发送。
   - 外部调用者继续只通过 `ReplyGenerator.generate` 观察候选回复结果；不得把 PostgreSQL、LangChain、LangGraph 或 Deep Agents 类型暴露给调用者。

3. **幂等状态**
   - 幂等范围使用已验证的 `owner_id + contact_id + request_key`。
   - 相同键和相同规范化输入在完成后直接重放原持久化结果，不再次运行模型。
   - 相同键但不同输入返回稳定冲突。
   - 有效租约内的重复调用返回稳定的处理中状态，不启动第二次运行。
   - 失败或租约过期后可以使用同一请求身份重试；尝试次数需要保留，完成结果只能成功写入一次。

4. **候选继续**
   - 历史候选只通过用户显式提交的 `continued_from_candidate_id` 进入新回复任务。
   - 继续操作创建新的回复任务，不覆盖原请求或原候选。
   - 存储层必须再次验证前序候选属于相同 owner、contact 和会话绑定。
   - 不再使用“上一轮未发送候选”作为自动输入，也不根据时间、复制动作或没有观察到发送来推断。

5. **SkillPort**
   - `SkillPort` 保持现有两个只读操作：读取当前联系人范围目录，以及按版本标识加载不可变正文。
   - 目录只包含当前 owner 的全局 Skill 和当前 contact 的专属 Skill，并且只包含已启用的当前版本。
   - 不存在、禁用、已删除和跨 owner/contact 的版本使用相同的安全失败，不泄漏该版本是否存在。
   - 回复运行时与数据库返回值都要执行 scope、版本、名称、描述和启用状态的防御性复核。
   - Skill 创建、网络安装、更新、启用、禁用和删除操作不加入 `SkillPort`；它们属于独立 Skill 管理 Module。

6. **Skill 身份、修订与审计**
   - Skill 库采用 owner 级单调递增的 `skill_library_revision`，不采用联系人级 revision。
   - 同一 owner 下任一 Skill 安装、更新、启用、禁用或删除时，revision 在同一事务中递增，并使该 owner 下所有联系人范围的旧目录失效。
   - 同一 owner 下的 Skill 名称唯一，包括全局 Skill 与联系人限定 Skill。
   - 回复请求记录实际使用的 Skill 和不可变版本，并记录 `auto` 或 `explicit` 选择方式、简短选择原因以及可空的置信度。
   - 重名安装如何提示、覆盖或改名属于后续 Skill 管理设计；只读 adapter 不得自行覆盖或重命名。

7. **Skill 删除语义**
   - 用户删除回复 Skill 后，所有版本的 `SKILL.md` 正文和来源定位都被清除。
   - 只保留内部 Skill/version 标识、名称、简述、内容摘要、删除时间和删除凭证组成的最小删除记录。
   - 引用该版本的历史回复可以保留版本关联，但不能恢复或宣称完整复现已删除正文。
   - 已删除 Skill 不进入目录、不能读取，并使旧目录、Tool 结果、摘要和 checkpoint 失效。

8. **最小 conversation_binding**
   - 本规格确认需要最小 `conversation_binding`，用于重新验证绑定标识确实属于当前 `owner_id + contact_id`，并且绑定状态仍有效。
   - 最小记录包含稳定绑定标识、owner、contact、状态和最近验证时间；OCR 窗口定位、截图来源、连续性与轮询字段不在本规格中固化。
   - 首次绑定、重名、会话变化、匹配不唯一或低置信度时必须由用户确认；不能只靠昵称、正文或模型静默锁定联系人。

9. **数据库状态**
   - 当前权威 schema 尚无正式的候选回复、回复 Skill 和会话绑定表，当前也没有 PostgreSQL `ReplyStore` 或 `SkillPort` adapter。
   - 恢复实施时需要新增相应 schema 与 PostgreSQL adapter，但具体的回复上下文快照表、关系记忆引用和来源删除级联必须等待相关 Module 与 Q10 决定，不能由本规格预先固化。
   - 任何需要重建已有开发库或测试库的破坏性操作都必须单独确认。

## Testing Decisions

1. **最高测试 seam**
   - PostgreSQL `ReplyStore` 恢复后，优先从现有 `ReplyGenerator.generate` Interface 验证成功、重放、冲突、运行中、失败重试和持久化失败行为。
   - 测试只观察公开结果和稳定领域错误，不读取 adapter 内部状态来证明行为。
   - 在记忆与回复上下文 Module 的 Interface 尚未完成前，不为测试创建一个临时生产上下文实现。

2. **SkillPort seam**
   - 直接从现有 `SkillPort` Interface 验证空目录、全局 Skill、联系人 Skill、owner/contact 隔离、版本读取、禁用/删除拒绝、owner 级 revision 和重复名称约束。
   - 测试不能绕过 `SkillPort` 直接断言 SQL 行来代替外部行为；数据库约束本身另以迁移集成测试验证。

3. **数据库集成验证**
   - 使用真实 PostgreSQL 和随机 owner/contact 的合成数据验证事务、唯一约束、复合 scope 和并发幂等；不验证尚未决定的来源到回复请求或候选的级联。
   - 测试复用现有 PostgreSQL adapter 的做法：每个测试创建独立 owner 范围，验证后只清理该测试自己的数据。
   - 数据库错误必须转换为不含 SQL、连接信息、聊天正文或 Skill 正文的稳定错误。

4. **联系人与 OCR 相关验证**
   - 最小 `conversation_binding` 测试覆盖正确 owner/contact、已撤销绑定、跨联系人绑定和低置信结果不能进入回复。
   - OCR 识别、轮询、窗口变化检测和发送观察的测试由后续桌面同步规格决定，本规格不创建假定的 OCR Interface。

5. **隐私测试数据**
   - 所有 unit、integration 和迁移验证只使用匿名合成消息与 Skill，不读取真实聊天导出目录，不打印真实联系人、聊天正文、文件名或凭据。

## Out of Scope

- 记忆 Module 的 Interface、schema、检索、分类、写入或删除。
- 回复上下文 Module 的 Interface、组装规则、近期消息范围、关系记忆选择、排序、预算或快照结构。
- PostgreSQL `ReplyStore` 的当前实现；它在用户明确恢复前保持暂停。
- OCR 截图、窗口监听、轮询频率、联系人标题识别、发送观察持久化和 macOS 集成。
- Skill 创建、安装、网络下载、更新、启用、禁用、删除命令及其管理界面。
- Q10 的来源删除后如何处理历史 `reply_request` 和候选；该行为尚未由用户决定。
- 真实模型供应商、外部出站台账、LangGraph checkpoint、自动发送和外部聊天写入。
- 读取、导入或显示任何真实聊天导出内容。

## Further Notes

- **已确认**：幂等选择 A、显式候选继续 A、owner 级 Skill revision 与 owner 内唯一名称 A、删除 Skill 正文并留最小记录 A、只读 `SkillPort`、最小 `conversation_binding`、Skill 选择方式/原因与可空置信度。
- **明确暂停**：任何需要修改或预先规定记忆 Module、回复上下文 Module 的工作，以及依赖这些决定的 PostgreSQL `ReplyStore` 实现。
- **尚未决定**：Q10。“来源删除”指用户主动删除导入文件、OCR 采集资料或整个联系人时的资料清理，不表示系统平时自动删除微信消息。它是否级联删除整个回复请求，留给后续删除规格决定。
- **OCR 技术说明，尚未固化**：OCR 可以在已验证且可见的会话中观察到用户发出的消息；同步关闭、微信不在前台或识别失败时，没有观察结果不能直接证明用户未发送。具体记录方式留给后续桌面同步规格。
- **建议但未确认**：桌面同步可优先监听微信前台/窗口变化，只对联系人标题区域执行 OCR，并用低成本画面变化检测代替持续完整 OCR；匹配不唯一或低置信时暂停并要求用户确认。
- **当前代码差异**：合成纵切仍使用自动的“上一轮未发送候选”内部对象，且 `ReplyStore.prepare` 仍包含上下文组装职责。这些是未来恢复 ReplyStore 时需要纠正的已知差异，不代表本轮授权修改。
