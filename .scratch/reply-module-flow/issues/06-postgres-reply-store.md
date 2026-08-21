# 06 — 接入 PostgreSQL ReplyStore

Type: task
State: resolved
Triage: ready-for-agent

**What to build:** 将已确认的 ReplyStore 生命周期接入 PostgreSQL，使回复请求、最小证据快照、候选、引用、运行状态和 Skill 审计信息在真实数据库中具备事务一致性、幂等重放、失败恢复和联系人范围隔离。

**Blocked by:** 03 — 建立联系人范围内的 Context、Retrieval 与 Memory 证据链；04 — 收敛 ReplyStore 的幂等与候选生命周期；05 — 持久化已验证会话绑定。

**Status:** ready-for-agent

- [x] 成功请求保存请求身份、已验证范围、最小证据快照、候选、引用和运行状态，并在提交成功后才返回候选。
- [x] 数据库唯一性和事务行为支持完成重放、幂等冲突、处理中、租约过期重试和显式候选继续。
- [x] 证据、候选和 Skill 记录不会跨 owner/contact 或 conversation binding 读取。
- [x] 数据库异常转换为不包含 SQL、连接信息、聊天正文或 Skill 正文的稳定领域错误。
- [x] 使用随机合成 owner/contact/message/memory 完成 PostgreSQL 集成测试，不修改旧的 ReplyStore 规格或预先固化未决定的删除级联。

## Answer

已完成 PostgreSQL ReplyStore 接入：

1. 新增 `database/migrations/007_reply_store.sql`，建立 `reply_request`、尝试、上下文证据、候选和引用表；幂等唯一键为 `owner_id + contact_id + idempotency_key`，候选引用通过复合外键限制在同一请求范围内。
2. 新增 `src/notalone/persistence/reply_store.py` 并从 `notalone.persistence` 导出。`start/save/fail/read` 均使用事务和请求行锁；完成结果重放、同键冲突、有效租约处理中、失败/过期重试、显式继续候选和联系人范围校验。
3. PostgreSQL adapter 只保存 Context 已产生的快照和实际 `SkillUse`/`skill_library_revision` 摘要，不准备 Context、不读取 Memory、不管理 Skill 目录、不生成模型回复、不提供发送接口。
4. 集成测试使用随机 owner/contact 和固定合成文本；`notalone_conversation_test` 上 persistence `34/34` 通过，unit `97/97` 通过，`compileall` 与 `git diff --check` 通过。
5. 默认 `notalone_test` 的全套测试为 `123` 个中 `3 failures / 22 errors / 2 skipped`；原因是该库仍停留在旧 schema，缺少 `channel_identity`、`wechat_message_metadata` 等 003-006 表，不能作为本任务失败依据。未修改旧 ReplyStore 规格，也未新增来源删除级联。
