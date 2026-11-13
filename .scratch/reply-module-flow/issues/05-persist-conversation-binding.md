# 05 — 持久化已验证会话绑定

Type: task
State: resolved
Triage: ready-for-agent

**What to build:** 为 `conversation_binding` 建立真实持久化能力，使外层候选回复流程能够在进程重启后重新验证当前会话属于哪个已确认联系人，并正确处理撤销、失配和范围隔离。

**Blocked by:** 01 — 外层流程验证联系人与会话范围。

**Status:** ready-for-agent

- [x] 持久化稳定的绑定标识、owner、contact、状态和最近验证时间等最小字段。
- [x] 进程重启或重新创建适配器后，已确认且有效的绑定仍可被验证。
- [x] 已撤销绑定、owner/contact 不匹配、会话变化和无效绑定不能返回 `Ready`。
- [x] 绑定查询和写入按 `owner_id + contact_id` 隔离，不用昵称或备注作为唯一键。
- [x] 使用匿名合成数据完成迁移、持久化和重新验证测试，不读取真实桌面或聊天数据。

## Answer

已完成会话绑定持久化纵切：

1. 新增 `database/migrations/006_conversation_binding.sql`，保存稳定绑定 UUID、`owner_id + contact_id`、渠道账号范围、会话定位线索、active/revoked 状态、最近验证时间和撤销时间，并通过复合外键、active 定位唯一索引和状态约束保护隔离与撤销语义。
2. 新增 `PostgresConversationBindingRepository` 与 `PostgresConversationPort`。用户确认后的绑定可以创建和撤销；重新创建 adapter 后按 owner 验证 active 绑定并刷新 `last_verified_at`；撤销、会话变化、模糊观察、错误 owner 或错误 contact 均不能把请求变成 `Ready`。
3. 新增匿名合成 PostgreSQL 集成测试，覆盖外层 `CandidateReplyFlow`、adapter 重建、撤销、会话变化、错误 owner/contact 和范围读取；未接入 OCR、桌面窗口或聊天正文。
4. 更新 `README.md` 与 `database/README.md`，明确 006 的执行顺序和当前真实桌面观察仍未接入的边界。

验证结果：在新建隔离数据库 `notalone_conversation_test` 上按 001→006 重放迁移，`tests/integration/persistence` 28/28 通过；`tests/unit` 97/97 通过；`compileall` 和 `git diff --check` 通过。默认 `notalone_test` 仍停留在旧 001 schema，全仓 123 个测试为 3 个既有导入失败、22 个既有 PostgreSQL schema 错误、1 个因未应用 006 的跳过；未发现本任务新增失败。
