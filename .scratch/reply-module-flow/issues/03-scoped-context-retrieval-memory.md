# 03 — 建立联系人范围内的 Context、Retrieval 与 Memory 证据链

Type: task
State: open
Triage: ready-for-agent

**What to build:** 让 Context 通过独立 Retrieval 查询同一联系人范围内的消息和已确认关系记忆，选择本次模型可见的最小证据并附带引用；Memory 独立管理关系记忆的候选、确认、修正、失效和删除，使这些状态变化反映到后续检索结果。Runtime 只消费 Context 产出的统一上下文，不直接查询消息或记忆。

**Blocked by:** 02 — 统一回复与改写输入。

**Status:** ready-for-agent

- [ ] Retrieval 提供消息查询和已确认关系记忆查询，并始终按 `owner_id + contact_id` 隔离。
- [ ] Context 根据输入类型和用户明确要求选择消息/记忆证据、预算、风险提示和引用，形成统一 `ReplyContext`。
- [ ] 关系记忆只有确认后才能进入回复上下文；修正、失效或删除后不会继续被检索。
- [ ] 混入其他 owner/contact 的消息、记忆或候选时 fail closed，不能靠昵称、备注或相似名称通过。
- [ ] Runtime 没有消息/记忆检索入口；改写模式在没有明确背景要求时不触发长期关系资料查询。
- [ ] 使用匿名合成数据完成模块行为测试，不引入真实聊天、截图或语音持久化。
