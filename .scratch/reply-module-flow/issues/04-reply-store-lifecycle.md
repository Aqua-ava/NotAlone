# 04 — 收敛 ReplyStore 的幂等与候选生命周期

Type: task
State: resolved
Triage: ready-for-agent

**What to build:** 将 ReplyStore 收敛为回复请求和结果的持久化边界，不再负责 Context 选择。它保存最小请求摘要、已验证范围、证据快照、候选和运行状态，并支持幂等重放、冲突、处理中、失败重试、租约过期和用户显式继续历史候选。

**Blocked by:** 02 — 统一回复与改写输入。

**Status:** ready-for-agent

- [x] 相同联系人范围、请求键和规范化输入的已完成请求直接重放原候选，不再次调用 Runtime。
- [x] 相同请求键但输入不同返回稳定冲突；有效运行租约内的重复请求返回处理中。
- [x] 失败或租约过期的请求可以安全重试，并保留尝试状态且只产生一个成功结果。
- [x] 历史候选只能由用户显式选择后继续；继续会创建新请求并再次验证 owner、contact 和会话绑定。
- [x] 删除“上一轮未发送候选”的自动继承路径，不根据未观察到发送来推断用户意图。
- [x] 候选只有在保存成功后返回；Store 不调用模型、不读写 Memory、不识别联系人、不发送消息。

## Answer

已完成 ReplyStore 生命周期收敛。`ReplyStore` 现在只负责 `start`、`save`、`fail`
和范围内读取：保存规范化请求摘要、已验证 owner/contact/binding、尝试与租约、Context
证据快照、候选和 Skill 结果。新增进程内 adapter 验证原子幂等、重放、冲突、处理中、
失败/租约重试及显式候选继续；`ReplyGenerator` 必须显式注入 `ReplyContext`，Context
和 Runtime 不会在重放请求上再次执行。已移除 `StoreBackedReplyContext`、`Store.prepare`
和“上一轮未发送候选”路径；未新增发送、Memory 或 PostgreSQL 能力。

验证：`conda run -n NotAlone python -m unittest discover -s tests/unit`（97/97 通过）；
`conda run -n NotAlone python -m compileall -q src tests` 通过；`git diff --check` 通过。
完整 `tests` 共 123 个，其中本次 reply 相关全部通过；剩余 3 个 ingest integration 失败
和 22 个 PostgreSQL 错误来自现有 `notalone_test` 未应用当前迁移，缺少
`public.channel_identity`、`public.wechat_message_metadata` 等表，不是本次 ReplyStore
代码路径。
