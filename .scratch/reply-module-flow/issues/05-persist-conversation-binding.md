# 05 — 持久化已验证会话绑定

Type: task
State: open
Triage: ready-for-agent

**What to build:** 为 `conversation_binding` 建立真实持久化能力，使外层候选回复流程能够在进程重启后重新验证当前会话属于哪个已确认联系人，并正确处理撤销、失配和范围隔离。

**Blocked by:** 01 — 外层流程验证联系人与会话范围。

**Status:** ready-for-agent

- [ ] 持久化稳定的绑定标识、owner、contact、状态和最近验证时间等最小字段。
- [ ] 进程重启或重新创建适配器后，已确认且有效的绑定仍可被验证。
- [ ] 已撤销绑定、owner/contact 不匹配、会话变化和无效绑定不能返回 `Ready`。
- [ ] 绑定查询和写入按 `owner_id + contact_id` 隔离，不用昵称或备注作为唯一键。
- [ ] 使用匿名合成数据完成迁移、持久化和重新验证测试，不读取真实桌面或聊天数据。
