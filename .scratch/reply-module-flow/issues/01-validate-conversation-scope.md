# 01 — 外层流程验证联系人与会话范围

Type: task
State: resolved
Triage: ready-for-agent

**What to build:** 候选回复请求先经过外层流程验证当前桌面会话是否绑定到一个明确、仍有效的 `owner_id + contact_id`，只有验证通过才进入 Reply。流程对外返回 `Ready`、`NeedsUserConfirmation` 或 `Rejected`，不把窗口标题、昵称或 OCR 文本直接当作联系人身份，也不提供发送能力。

**Blocked by:** None — can start immediately.

**Status:** resolved

- [x] 有效的已确认会话绑定返回 `Ready`，并产生包含 owner、contact 和 binding 标识的 `VerifiedConversationScope`。
- [x] 首次绑定、重名、会话变化、匹配不唯一或低置信度返回 `NeedsUserConfirmation`。
- [x] 绑定已撤销、范围不一致、输入缺失或安全校验失败返回 `Rejected`。
- [x] 非 `Ready` 请求不调用 Context、Runtime 或 Store，也不保存请求或候选。
- [x] 使用匿名合成联系人和会话完成公开行为测试，不读取真实桌面或聊天数据。

## Answer

已完成外层候选回复流程的第一条纵切：新增 `VerifiedConversationScope`、ConversationPort、合成内存会话绑定适配器和 CandidateReplyFlow。流程现在会在 Reply 前验证当前绑定；Ready 请求才调用现有 Reply 入口，确认中或拒绝状态不会调用 Reply。请求的幂等键、目标消息、表达方向、联系人范围和会话绑定也会在进入 Reply 前做最小运行时校验。

验证结果：#01 专项测试 14/14 通过；unit 测试 70/70 通过；`compileall` 和 `git diff --cached --check` 通过。完整 96 个测试中有 3 个失败、22 个错误，均为既有 PostgreSQL 集成测试；当前 `notalone_test` 缺少 `channel_identity`、`wechat_message_metadata` 等导入 schema，未涉及本次会话验证代码。

剩余边界：既有 `ReplyGenerator` 低层接口仍为兼容当前纵切而保留，统一两种输入并把应用层流程作为唯一 Reply 入口的契约迁移留给 #02；本任务没有接入 OCR、真实桌面或 PostgreSQL。
