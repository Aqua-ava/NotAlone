# 02 — 统一回复与改写输入

Type: task
State: resolved
Triage: ready-for-agent

**What to build:** 在已验证联系人范围内建立一个统一 Reply 入口，同时支持“针对目标消息按表达方向回复”和“使用用户原句进行改写与润色”。两种输入都经过 Context、Runtime 和 Store，返回已保存、带依据、可编辑但不会自动发送的候选。

**Blocked by:** 01 — 外层流程验证联系人与会话范围。

**Status:** resolved

- [x] 目标消息加用户确认表达方向可以生成候选，并保留目标消息与方向的请求语义。
- [x] 用户原句加可选的一次性改写要求可以生成候选，并默认保留原意、进行基础润色。
- [x] 两种输入共享同一个 Reply 入口和联系人范围校验，不接受昵称或窗口标题替代已验证范围。
- [x] 一次性改写要求只影响当前请求，不写入 Memory、长期偏好或 Skill；普通改写不默认检索长期关系资料。
- [x] 候选在 Store 成功保存并通过依据、引用和范围校验后才返回，系统没有外部发送能力。

## Answer

已完成第 02 任务：

1. 新增公开 `RewriteDraft(draft_text, user_instruction)` 与 `ReplyInput` 联合输入；目标消息回复和草稿改写共用 `GenerateReply`/`ReplyGenerator` 入口。
2. `CandidateReplyFlow` 支持两种输入，并在 `Ready` 后把必填的 `VerifiedConversationScope` 传入 Reply；范围不匹配会在 Context/Runtime/Store 之前拒绝。
3. Context 快照支持用户草稿依据；Runtime 区分两种输入，默认改写明确只做基础润色并保留原意，一次性要求不写入长期模块。改写上下文混入长期关系记忆时 fail closed。
4. 候选继续经过引用、联系人范围、保存结果一致性校验后才返回；没有新增外部发送能力。README 已同步公开边界。

验证结果：`tests/unit` 80/80 通过；`compileall`、`git diff --cached --check` 通过。完整测试集为 106 个，其中本次相关单元测试通过；剩余 3 个失败、22 个错误均来自既有 PostgreSQL 集成测试数据库 schema 未初始化（如缺少 `public.channel_identity`、`public.wechat_message_metadata`），不是本次回复代码路径。正式 Context/Retrieval 拆分和 Store 生命周期收敛分别留给后续 #03/#04；当前仍保留 `Store.prepare()` 过渡兼容边界。
