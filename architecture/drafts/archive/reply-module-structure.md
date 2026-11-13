# 候选回复模块结构草案

> 2026-10-21 决定收敛：旧两模式、先方向确认及探索不使用 Skill 的设计按 ADR-079／043 解释为历史。Runtime 按需只读补查已由 [ADR-090](../../adr/090-bounded-runtime-history-retrieval.md)正式确认；本草案的旧结构图不是当前完整实现图。

> 状态：已收束；正式决定见 ADR-012
> 日期：2026-08-21
>
> 本文记录设计定稿时的模块关系；对应[实现规格](../../../.scratch/reply-module-flow/spec.md)及 8 张任务已关闭。本文不是新的待实现入口，也不证明真实微信或最终原生 App 已验收。

> 2026-10-22 归档：本文已收束（ADR-012），移入 `drafts/archive/` 仅作追溯，不作为设计入口。

## 1. 总体关系

NotAlone 的候选回复由外层应用流程和 Reply 模块共同完成：

```text
UI / 快捷键
  -> 候选回复流程
       -> 验证联系人与会话绑定
       -> Reply.generate(VerifiedConversationScope, ReplyInput)
            -> Context
            -> Runtime
            -> Store
```

外层流程先确认当前请求对应的联系人和已验证会话。重名、会话变化、绑定失效或识别置信度不足时，不进入 Reply 模块，而是要求用户确认。

Reply 模块只处理已经确认联系人范围内的候选回复，不识别微信窗口，也不自行选择联系人。

## 2. Reply 内部模块

### Context

Context 决定本次回复让模型看到哪些资料，并输出统一的 `ReplyContext`。

- 支持 `reply_to_message` 和 `rewrite_draft` 两种输入模式。
- 通过 Retrieval 查询消息和关系记忆。
- 选择少量证据、附带引用、预算和风险提醒。
- 不加载 Skill 正文，不保存回复结果。

### Runtime

Runtime 根据 `ReplyContext` 生成结构化候选。

- 通过应用层装配的受控只读工具，按 [ADR-090](../../adr/090-bounded-runtime-history-retrieval.md)在本次范围与预算内补查历史；不直接访问任意存储、不跨联系人、不写入资料。
- 通过 `SkillPort` 按需读取最多一个 Reply Skill。
- LangChain、Deep Agents 和模型供应商属于 Runtime 的 Adapter。
- 返回候选、依据、引用、风险说明和实际使用的 Skill。

### Store

Store 保存一次回复任务及其结果。

- 保存请求摘要、请求状态、幂等键、尝试次数和租约信息。
- 保存本次实际使用的最小证据快照、候选、引用和 Skill 记录。
- 支持相同请求重放、失败重试和显式候选继续。
- 不保存完整聊天历史，不负责联系人识别，不调用模型。
- 来源或联系人删除时，相关回复快照和候选按删除规则清理。

最终的 Store 接口不应继续承担上下文选择；当前纵切的 `prepare()` 仍是过渡形态。

## 3. Reply 输入模式

两个模式共用一个 Reply 入口，输入类型使用联合结构：

```python
ReplyToMessage(
    target_message_id,
    direction,
)

RewriteDraft(
    draft_text,
    user_instruction,
)
```

`ReplyToMessage` 需要用户确认的本次表达方向。`RewriteDraft` 的原句和可选的 `user_instruction` 都由用户输入；没有改写要求时，系统只做基础润色并保留原意。改写要求只影响当前请求，不沉淀为长期偏好或关系记忆。

## 4. Retrieval 与 Memory 的位置

```text
backend/src/notalone/
├── memory/          关系记忆的权威管理与目录维护
├── retrieval/       消息和关系记忆的查询能力
└── reply/           候选回复业务模块
```

Retrieval 是一个独立模块，对外提供两个明确的查询能力：

```python
search_messages(...)
search_confirmed_memories(...)
```

Memory 负责关系记忆的创建、修正、失效、删除和联系人记忆目录；Retrieval 只负责按联系人范围查找资料；Context 决定本次回复使用哪些查询结果。

## 5. 设计定稿时的实现缺口（历史，已收口）

以下清单保留当时的拆分背景。2026-10-04 的规格收尾记录已覆盖外层流程、两种输入、独立模块合同、Store/SkillPort 持久化及来源删除；当前代码位于 `backend/src/notalone/`，实际路径由对应任务记录。不根据这些历史缺口重开任务，运行和渠道能力继续按当前代码、测试及独立验收判断。

- 外层候选回复流程和 `VerifiedConversationScope`。
- `RewriteDraft` 公开输入类型。
- 正式 Context、Retrieval 和 Memory 模块。
- PostgreSQL ReplyStore 与 SkillPort。
- 来源删除与回复快照之间的最终级联细节。
