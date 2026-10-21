# ADR-012：候选回复流程与内部模块边界

> 2026-10-21 设计审查：“Runtime 初期不直接检索”是阶段约束；生产运行时现已装配受控历史搜索／窗口工具，见[现行回复流程](../current/core-flows.md)和[上下文规格](../../.scratch/memory-skill-context/spec.md)。未找到明确闭合该阶段限制的 ADR 替代条款，本次将其记录为待复审接口边界；不据代码存在新增工具权限，应用层冻结范围、预算和来源复验仍有效。

> 状态：已采纳
> 2026-10-11 局部修订见 [ADR-043](043-conversation-scenarios-and-direction-exploration.md)；不改变既有只读、联系人隔离和禁止发送边界。
> 日期：2026-08-21

NotAlone 的候选回复既需要先确认当前会话对应的联系人，又需要把资料选择、模型运行和结果保存分开。若让 Reply 自己识别联系人，或让 Store 组装上下文，联系人安全边界和模块职责会混在一起。

## 决策

1. 建立应用层候选回复流程。它先验证联系人与会话绑定，返回 `Ready`、`NeedsUserConfirmation` 或 `Rejected`；只有 `Ready` 才调用 Reply。验证后的 `VerifiedConversationScope` 至少包含 `owner_id`、`contact_id` 和 `conversation_binding_id`。Reply 不识别微信窗口，也不静默选择联系人。
2. Reply 内部保持三个职责模块：`Context` 选择本次资料并生成统一 `ReplyContext`；`Runtime` 根据上下文生成候选；`Store` 保存请求、最小证据快照、候选和运行状态。Context、Runtime、Store 不直接对 UI 暴露。
3. `reply_to_message` 与 `rewrite_draft` 共用一个 Reply 入口。前者接收目标消息和已确认表达方向；后者接收用户原句和可选的 `user_instruction`。改写要求只作用于当前请求，不沉淀为关系记忆或长期偏好。
4. `Memory` 与 `Retrieval` 是和 Reply 平级的模块。Memory 管理关系记忆及 `contact_memory_index`；Retrieval 提供消息查询和已确认关系记忆查询；Context 通过 `RetrievalPort` 选择本次使用的结果。Runtime 初期不直接调用动态检索 Tool。
5. `SkillPort` 仍由独立 `skills` 模块提供，LangChain/Deep Agents 只在 Reply Adapter 中接入。PostgreSQL 适配器集中放在 `persistence/`，业务规则留在对应模块。当前 `context.py`、`runtime.py`、`store.py` 先保持为文件，只有出现多个实现或明显复杂度时再升级为子目录。

## 后果

- 外层应用流程、Reply 业务模块、Memory、Retrieval、Conversation 和基础设施 Adapter 的依赖方向清晰，避免 Reply 变成联系人识别、检索、模型和持久化的大杂烩。
- Store 的最终接口不能继续承担上下文选择；当前纵切的 `prepare()` 只是过渡形态。
- 改写模式默认以用户草稿为核心，不自动检索关系资料；用户明确要求结合联系人背景时，再通过 Context 选择资料。
- 会话绑定和联系人确认成为 Mac 同步与候选回复共同复用的能力，Mac 的 ScreenCaptureKit/OCR 仍属于外部 Adapter。
