# 01 — 外层流程验证联系人与会话范围

Type: task
State: open
Triage: ready-for-agent

**What to build:** 候选回复请求先经过外层流程验证当前桌面会话是否绑定到一个明确、仍有效的 `owner_id + contact_id`，只有验证通过才进入 Reply。流程对外返回 `Ready`、`NeedsUserConfirmation` 或 `Rejected`，不把窗口标题、昵称或 OCR 文本直接当作联系人身份，也不提供发送能力。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] 有效的已确认会话绑定返回 `Ready`，并产生包含 owner、contact 和 binding 标识的 `VerifiedConversationScope`。
- [ ] 首次绑定、重名、会话变化、匹配不唯一或低置信度返回 `NeedsUserConfirmation`。
- [ ] 绑定已撤销、范围不一致、输入缺失或安全校验失败返回 `Rejected`。
- [ ] 非 `Ready` 请求不调用 Context、Runtime 或 Store，也不保存请求或候选。
- [ ] 使用匿名合成联系人和会话完成公开行为测试，不读取真实桌面或聊天数据。
