# 04 — L0 历史按需查询 Tool

**What to build:** 当用户的问题需要较早历史时，模型可以在同一轮候选回复中先搜索相关 L0，再按需要读取指定会话的连续上下文；用户不会看到全量历史被一次性放入 Prompt，查询也不会越过当前联系人范围。

**Blocked by:** 03 — 基础 ReplyContext 必须先提供当前任务和联系人范围。

**Status:** ready-for-agent
**State:** open
**Triage:** ready-for-agent

- [x] 提供职责分离的相关性搜索和时间顺序查询能力，对照 TencentDB 的 `conversation_search` 与 `conversation_query`。
- [x] 相关性搜索返回受限的原始消息结果，包含角色、时间、会话标识、消息 ID 和来源 ID。
- [x] 时间顺序查询只读取指定会话或命中位置附近的有限完整消息，不负责全库相关性排序。
- [x] Owner、联系人、来源有效性和删除状态由服务端强制校验，模型不能通过参数扩大范围或执行 SQL。
- [x] 每轮 L0/L1 历史搜索调用合计不超过运行预算，默认最多 3 次；Top-K、Token、时间和超时均受限。
- [x] Tool 结果作为同一轮 Tool 上下文继续生成，并标记为不可执行的原始证据。
- [x] 空结果、超时或失败会安全回退，不让模型把“未命中”解释为“事实不存在”。
- [x] 候选引用只能来自本轮实际返回且通过联系人范围校验的 L0 结果。

## Answer

已完成 L0 历史按需查询 Tool：

1. `RetrievalPort` 增加有限时间顺序查询；PostgreSQL 和 InMemory 适配器分别实现联系人范围、有效来源、时间窗、锚点前后窗口和角色映射。
2. 新增绑定已验证联系人/会话的 `HistoryToolAccess`，由 `conversation_search` 与 `conversation_query` 分职责执行；模型不能传入 owner/contact、不能执行 SQL 或跨会话查询。
3. LangChain Reply Runtime 在同一轮注册两个只读 Tool，结果携带 message/role/time/session/source 元数据并转成当前 ReplyContext 的临时证据；不命中、失败、超时和预算耗尽只返回无事实状态。
4. 每轮最多 3 次历史 Tool 调用，限制 Top-K、窗口、token、单次超时和 PostgreSQL statement timeout；只保存 Tool 名称、状态、延迟和引用 ID，不保存 Tool 原始返回全文。

验证：历史 Tool 单元测试 6 个、检索单元测试与 ReplyGenerator 合成测试共 31 个通过；PostgreSQL 消息检索集成测试通过；LangChain 同轮 Tool 证据测试通过。未增加外部发送能力，历史正文只在用户请求的当前运行中按需提供。

**State:** resolved
