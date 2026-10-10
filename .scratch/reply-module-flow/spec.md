# 候选回复应用流程与 Reply 三模块规格

Type: task
State: resolved
Triage: ready-for-agent
Implementation: completed

## Problem Statement

NotAlone 已经有一个可以生成合成候选回复的纵切，但当前纵切把联系人范围验证、回复上下文、运行时生成和结果保存压缩在一个较粗的内部流程中。随着产品同时支持“表达方向回复”和“改写与润色”两种用户输入，如果继续沿用这个形态，容易出现以下问题：

1. Reply 自己识别当前微信会话或联系人，导致未确认、重名或会话变化时错误地生成回复。
2. Context、Runtime、Store 的职责相互渗透，尤其是 Store 的过渡性 `prepare` 同时承担上下文准备和持久化边界。
3. 改写请求中的用户原句和一次性改写要求被误当成长期关系偏好，污染 Memory。
4. 消息检索、关系记忆检索和 Reply 运行时之间没有清楚的依赖方向，后续容易把动态检索 Tool 直接塞进模型运行时。
5. 已确认联系人范围、候选依据、重放、失败重试和显式继续缺少一个能跨会话复用的应用层测试入口。

本规格把已经确认的设计决策固定下来，作为后续 `to-tickets` 和实现工作的唯一任务入口。它描述目标行为，不代表所有模块现在都已经实现。

## Solution

建立一个薄的应用层 `candidate_reply_flow`，作为候选回复请求的最高测试 seam。它先验证当前用户、联系人和桌面会话绑定，再把已验证的范围交给一个统一的 Reply 入口。Reply 内部依次经过 Context、Runtime 和 Store；Memory、Retrieval、Conversation、Skills 和持久化属于独立边界。

对外行为只有三类：

- `Ready`：当前会话已经验证到一个明确联系人，可以进入 Reply。
- `NeedsUserConfirmation`：首次绑定、重名、会话变化、匹配不唯一或置信度不足，需要用户选择或确认。
- `Rejected`：请求缺少必要范围、绑定已撤销、输入非法、跨联系人或其他安全条件不满足，不能生成候选。

只有 `Ready` 的请求才允许执行 Context、Runtime 或 Store。无论是回复目标消息，还是改写用户草稿，都经过同一个 Reply 入口，并返回带依据、可编辑、尚未发送的候选；最终发送始终由用户在外部聊天应用中手动完成。

## Public Seam

最高测试 seam 是应用层 `candidate_reply_flow` 的请求与结果行为。测试通过它提交一个候选回复请求，并观察 `Ready`、`NeedsUserConfirmation`、`Rejected`、候选结果、稳定领域错误和重放结果；测试不依赖 LangChain、Deep Agents、PostgreSQL、OCR 或具体模型类型。

Reply 内部的次级 seam 是统一的 Reply 入口。它接收 `VerifiedConversationScope` 和一个联合输入：

- 回复目标消息：目标消息标识 + 用户确认的表达方向。
- 改写草稿：用户原句 + 可选的一次性改写要求。

`VerifiedConversationScope` 至少包含 `owner_id`、`contact_id` 和 `conversation_binding_id`，并代表当前请求已经通过外层会话绑定验证。Reply 不接受一个未验证的昵称、联系人名或窗口标题来替代这个范围。

## User Stories

1. As a NotAlone 用户, I want 回复请求先验证当前会话绑定, so that 每一条候选都明确对应我确认过的联系人。
2. As a NotAlone 用户, I want 首次绑定时被要求确认, so that 系统不会把第一次看到的窗口标题当成联系人身份。
3. As a NotAlone 用户, I want 重名、会话改名、绑定失效和低置信度匹配被拦截, so that 联系人识别的不确定性不会变成错误回复。
4. As a NotAlone 用户, I want 验证失败时不调用 Context、Runtime 或 Store, so that 未确认范围不会触发检索、模型调用或候选持久化。
5. As a NotAlone 用户, I want 回复目标消息和改写草稿共用一个 Reply 入口, so that 两种输入遵循同一套联系人安全边界和候选结果约束。
6. As a NotAlone 用户, I want 用“温柔地回复他”这类表达方向生成候选, so that 我可以描述想表达的方向而不必先写出完整回复。
7. As a NotAlone 用户, I want 用自己的原句请求改写或润色, so that 系统可以改善表达但不替换我的基本意图。
8. As a NotAlone 用户, I want 一次性改写要求只影响当前请求, so that “更温柔一点”不会被默认为长期关系偏好或写入 Memory。
9. As a NotAlone 用户, I want 改写模式默认不读取长期关系资料, so that 普通润色不会无必要地扩大敏感数据处理范围。
10. As a NotAlone 用户, I want 明确要求结合联系人背景时才使用关系资料, so that Context 的资料选择有清楚的用户意图边界。
11. As a NotAlone 用户, I want Context 负责决定本次模型可见的资料, so that Runtime 只关注生成而不会自行扩大检索范围。
12. As a NotAlone 用户, I want 消息检索和已确认关系记忆检索由独立 Retrieval 提供, so that查询能力可以复用而不把事实生命周期混进 Reply。
13. As a NotAlone 用户, I want Memory 独立管理关系记忆候选、确认、修正、失效和删除, so that Reply 不会直接修改长期关系事实。
14. As a NotAlone 用户, I want Runtime 通过受控 SkillPort 使用最多一个回复 Skill, so that本次生成采用的策略可以解释且不会获得未授权能力。
15. As a NotAlone 用户, I want Store 保存本次请求的最小证据、候选和状态, so that我能重看依据，同时避免保存完整聊天历史或不必要的敏感数据。
16. As a NotAlone 用户, I want 相同请求在完成后重放原候选, so that网络重试不会再次调用模型或制造重复任务。
17. As a NotAlone 用户, I want 相同幂等键但不同输入得到稳定冲突, so that一个请求身份不会代表两个不同的回复意图。
18. As a NotAlone 用户, I want 运行中的重复请求返回处理中, so that并发请求不会同时生成两组候选。
19. As a NotAlone 用户, I want 失败或租约过期的请求能够安全重试, so that临时故障不会迫使我伪造新的请求身份。
20. As a NotAlone 用户, I want 只有明确选择历史候选时才继续它, so that系统不会因为“上一轮没有观察到发送”就擅自继承候选。
21. As a NotAlone 用户, I want 继续历史候选时再次验证 owner、contact 和会话绑定, so that其他联系人的候选不能跨范围进入当前请求。
22. As a NotAlone 用户, I want 候选返回前必须已经成功保存, so that用户不会看到一个无法追踪、无法重放或没有依据的候选。
23. As a NotAlone 用户, I want 候选带有来源依据并可编辑, so that我能理解系统为什么这样回复并在发送前亲自修改。
24. As a NotAlone 用户, I want 系统永远不替我发送外部消息, so that最终发送仍由我在聊天应用中手动完成。
25. As a NotAlone 用户, I want 所有联系人范围按 `owner_id + contact_id` 隔离, so that昵称、备注和窗口展示名称不会成为安全边界。
26. As a NotAlone 用户, I want 运行时、Store 和 Retrieval 都对范围做防御性复核, so that单个适配器或模型返回错误数据时能够 fail closed。
27. As a NotAlone 用户, I want 代码中的 Reply、Memory、Retrieval、Conversation 和持久化依赖方向清晰, so that任何一个模块都不会偷偷承担其他模块的生命周期职责。
28. As a NotAlone 用户, I want 规格明确区分“已实现”和“待实现”, so that后续 Agent 不会把架构文档误当成可用的端到端功能。

## Implementation Decisions

1. **应用层先做身份和会话验证**

   应用流程负责接收 UI 或快捷键传入的当前会话信息，调用 Conversation 能力验证绑定，并返回 `Ready`、`NeedsUserConfirmation` 或 `Rejected`。它可以负责流程编排和错误映射，但不负责检索排序、模型生成、Skill 选择或候选持久化规则。

   `VerifiedConversationScope` 是进入 Reply 的唯一联系人范围证明。它至少携带 `owner_id`、`contact_id` 和 `conversation_binding_id`；昵称、备注、窗口标题和 OCR 文本只能作为验证输入或展示信息，不能替代它。

2. **Reply 只有一个统一入口和三个内部职责**

   Reply 的统一入口接收已验证范围与联合输入，返回候选结果或稳定领域错误。入口内部的职责边界如下：

   - Context：根据输入类型和明确的用户要求，通过 Retrieval 查询并选择本次模型可见的消息、已确认关系记忆、依据、预算和风险提示，形成统一 `ReplyContext`。
   - Runtime：消费 `ReplyContext`，调用模型和最多一个受控 Reply Skill，生成结构化候选、依据、引用、风险和实际使用的 Skill 信息。Runtime 不直接查询消息或关系记忆。
   - Store：保存请求身份、最小实际证据快照、候选、引用、Skill/run 状态和失败信息，提供幂等、重放、失败重试和显式候选继续。Store 不识别联系人、不组装上下文、不调用模型、不管理 Memory、不发送消息。

   这三个职责属于 Reply 内部，不直接对 UI 暴露。当前代码中的 `context.py`、`runtime.py`、`store.py` 可以继续作为文件；只有出现多个实现或明显复杂度时才升级为子目录。

3. **两种输入模式**

   回复目标消息模式接收目标消息标识和用户确认的表达方向，例如“温柔地回复他”。它需要 Context 选择目标消息和相关资料。

   改写草稿模式接收用户自己提供的原句和可选的一次性 `user_instruction`。没有改写要求时默认只做基础润色并尽量保留原意；一次性要求只存于当前请求，不写入 Memory 或长期偏好。除非用户明确要求结合联系人背景，改写模式不默认做关系资料检索。

4. **Memory 与 Retrieval 是 Reply 的平级模块**

   Memory 是关系记忆的权威管理模块，负责 `memory_candidate`、`confirmed_memory`、联系人记忆目录及其创建、确认、修正、失效、删除和来源关联。

   Retrieval 是查询模块，提供按已验证联系人范围执行的消息检索和已确认关系记忆检索。它不拥有关系事实生命周期，也不决定哪些结果最终进入模型上下文。Context 通过 RetrievalPort 使用它；消息存储、Memory 存储和索引实现可以在 Retrieval 内部适配。

   第一阶段不把动态消息/记忆检索 Tool 直接交给 Runtime。Runtime 只能消费已经由 Context 选定并带引用的 `ReplyContext`。

5. **Skill 与运行时适配器保持独立**

   SkillPort 由独立 Skills 模块提供只读目录和不可变版本读取能力。Runtime 可以记录本次最多使用一个 Skill、使用方式、选择原因和可空置信度，但 Skill 的创建、安装、更新、启用、禁用和删除属于后续 Skill 管理工作。

   LangChain、Deep Agents、具体模型供应商和其他框架类型只能出现在 Reply 的运行时适配器边界，不得泄漏到应用流程、Reply 公共入口或领域数据合同中。

6. **Store 的数据与幂等边界**

   Store 只保存完成本次请求所需的最小数据：请求摘要和规范化输入、已验证范围、状态、尝试次数/租约、最小证据快照、引用、候选、运行与 Skill 审计信息。它不保存完整聊天历史，不把动态 Tool 结果或模型线程 checkpoint 当成业务事实。

   幂等范围使用已验证的 `owner_id + contact_id + request_key`。相同键和相同规范化输入在已完成时重放原结果；相同键不同输入返回稳定冲突；有效租约内的重复请求返回处理中；失败或租约过期后允许同一请求身份重试，并保证成功结果只写入一次。

   历史候选只有在用户显式提交 `continued_from_candidate_id` 时才能继续。继续会创建新的请求，不覆盖原请求，并再次验证候选的 owner、contact 和 conversation binding。

7. **结果与发送边界**

   候选必须经过结构校验、联系人范围校验、依据/引用校验和 Store 成功保存后才能返回给用户。候选始终可编辑，不提供发送 Tool、后台发送能力或聊天应用写入权限。

8. **隐私与删除**

   所有新测试和示例只使用匿名合成数据。原始聊天、截图和语音不因本规格而新增持久化或上传。

   Store 保存的证据快照和候选必须保留来源与删除路径；联系人或来源删除后的级联细节需要由后续删除规格决定。本规格不把未决定的级联行为写成代码契约。

## Testing Decisions

1. **应用流程行为测试**

   通过 `candidate_reply_flow` 的最高 seam，使用 fake Conversation、Context、Runtime 和 Store 验证：

   - 未绑定、绑定已撤销、会话变化、重名、低置信度或跨联系人时返回确认/拒绝，且下游 fake 没有调用记录。
   - 已验证范围和回复目标消息进入 Context、Runtime、Store，并返回已持久化候选。
   - 已验证范围和改写草稿进入同一入口；原句与一次性要求被保留在当前请求中，但不会自动变成长期偏好。
   - Context 的消息/关系记忆查询经过 RetrievalPort；Runtime 不能绕过 Context 直接查询。
   - Runtime 或 Store 失败时不向用户返回未经持久化或未经校验的候选。

2. **Store 行为测试**

   通过 Store 的公开合同验证相同请求重放、幂等冲突、运行中重复、失败重试、租约过期、显式候选继续和跨联系人拒绝。测试观察领域结果，不依赖数据库内部表结构或 SQL 异常文本。

3. **范围与证据测试**

   验证每条候选都带已验证范围、来源依据和稳定引用；混入其他 owner/contact 的消息、记忆、候选或 Skill 目录时必须 fail closed。昵称、备注、窗口标题和相似联系人名称不能通过测试。

4. **模块边界测试**

   用依赖检查或最小 fake 验证 Reply 不导入具体 PostgreSQL、OCR、桌面同步或外部发送实现；Runtime 不直接依赖消息/记忆查询；Store 不承担 Context 选择；Memory 不被一次性改写要求写入。

5. **集成验证**

   后续实现任务可以分别增加真实 PostgreSQL、Retrieval、Memory 和会话绑定集成测试，但每个测试必须使用匿名合成 owner/contact/message/memory。没有端到端验证前，不得宣称桌面同步、真实模型或生产持久化已经可用。

6. **最小验收集合**

   实现完成前至少应有：应用流程成功/确认/拒绝三态测试、两种输入模式测试、Context-Retrieval 调用边界测试、Runtime-Store 成功链路测试、Store 幂等与失败恢复测试、联系人隔离测试、无发送能力检查，以及项目规定的 unit、compile 和 diff 检查。

## Out of Scope

- 本规格不直接实现代码、数据库迁移、生产 PostgreSQL adapter 或真实模型接入。
- 不实现或预先固化 Memory 的完整 schema、记忆提取/确认策略、关系记忆排序和删除级联。
- 不实现 Retrieval 的具体向量库、全文索引、排序算法或查询预算；只定义它作为独立查询边界。
- 不实现 OCR、ScreenCaptureKit、窗口监听、微信会话标题识别、前台增量同步或发送观察。
- 不实现 UI、快捷键、候选编辑界面或外部聊天应用集成。
- 不把动态检索、发送、Shell、网络、安装包或子 Agent 暴露为 Runtime Tool。
- 不把一次性改写要求沉淀为长期偏好、关系记忆或 Skill。
- 不处理真实聊天导出、真实联系人资料、截图、语音或凭据。
- 不修改既有 [PostgreSQL ReplyStore/SkillPort 历史规格](../postgres-reply-store-skill-port/spec.md)；设计定稿时它是等待上下文与记忆边界稳定的独立工作项，现已标为 superseded，由本轨 05/06/07 及 Skill 管理轨覆盖，不另计待实现。

## Current Implementation Gap（历史，2026-10-04 已收口）

以下记录拆票前的实现缺口，现已由 8 张 resolved 任务覆盖，收尾与验证见 Comments；它们不再是新的待实现项：

1. 应用层 `candidate_reply_flow` 与正式 `VerifiedConversationScope`。
2. `RewriteDraft` 公开输入及两个输入模式的统一 Reply 入口。
3. 正式 Context、Retrieval、Memory 和 Conversation 模块合同及适配器。
4. 让 Store 从过渡性的上下文准备职责中退出，收敛为请求/结果持久化合同。
5. PostgreSQL ReplyStore、SkillPort 和会话绑定持久化。
6. 来源删除与 Reply 快照/候选之间的最终级联规则。

上述“仅有候选回复纵切”描述属于设计定稿时的历史阶段。当前模块实现和验证已按原任务收口；真实微信、最终原生 App 及外部模型质量仍按各自任务判断，不由本规格 resolved 推导。

## Further Notes

- 已确认：Reply 拆为 Context、Runtime、Store；Memory 与 Retrieval 独立且与 Reply 平级；两个用户输入共用一个入口；外层流程负责联系人/会话验证；最终消息由用户手动发送。
- 已确认：改写的原句和可选要求都来自用户；改写要求只作用于当前请求；普通改写默认不自动检索长期关系资料。
- 已确认：Store 保存请求和候选的价值在于幂等、重放、失败恢复、审计和依据追踪，但不保存完整聊天历史或承担上下文选择。
- 历史代码差异：设计定稿时的过渡性上下文准备合同和“上一轮未发送候选”路径已由后续任务收敛到显式继续及 Context/Store 边界，不能继续按旧缺口拆票。
- 后续路径：本规格及实现任务已关闭；新聊天交互从持续会话和聊天回复策略草图收束，现有原生/渠道能力按独立验收任务推进，不重复发布本规格任务。

## Comments

- 2026-10-04：收尾核验后关闭。8 张 issue 全 resolved，spec 的“Current Implementation Gap”6 项逐条已有实现与覆盖：过渡性 `prepare` 已删除、`VerifiedConversationScope` 与三态流程（`application/candidate_reply_flow.py`）、两种输入（`reply/interface.py`）、Store 幂等／重放／冲突／租约／显式继续（`reply/store.py`）均有对应单测，`tests/unit/reply` 128 项与 `tests/unit/application` 49 项通过。头部的 `Implementation: not-started` 字段是拆分任务前的历史状态，已不再成立。
- 2026-10-10：同步关闭后的元信息与历史段落；`Implementation` 改为 completed，缺口和拆票建议明确标为历史。只核对既有代码、8 张任务状态及关闭记录，没有重跑模型或把旧模块验证当作本轮原生/渠道验收。
