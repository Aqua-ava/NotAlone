# 06 — 接入 PostgreSQL ReplyStore

Type: task
State: open
Triage: ready-for-agent

**What to build:** 将已确认的 ReplyStore 生命周期接入 PostgreSQL，使回复请求、最小证据快照、候选、引用、运行状态和 Skill 审计信息在真实数据库中具备事务一致性、幂等重放、失败恢复和联系人范围隔离。

**Blocked by:** 03 — 建立联系人范围内的 Context、Retrieval 与 Memory 证据链；04 — 收敛 ReplyStore 的幂等与候选生命周期；05 — 持久化已验证会话绑定。

**Status:** ready-for-agent

- [ ] 成功请求保存请求身份、已验证范围、最小证据快照、候选、引用和运行状态，并在提交成功后才返回候选。
- [ ] 数据库唯一性和事务行为支持完成重放、幂等冲突、处理中、租约过期重试和显式候选继续。
- [ ] 证据、候选和 Skill 记录不会跨 owner/contact 或 conversation binding 读取。
- [ ] 数据库异常转换为不包含 SQL、连接信息、聊天正文或 Skill 正文的稳定领域错误。
- [ ] 使用随机合成 owner/contact/message/memory 完成 PostgreSQL 集成测试，不修改旧的 ReplyStore 规格或预先固化未决定的删除级联。
