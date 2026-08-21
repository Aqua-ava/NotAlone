# 08 — 完成候选回复端到端集成与边界验收

Type: task
State: resolved
Triage: ready-for-agent

**What to build:** 将外层会话验证、两种 Reply 输入、Context、Retrieval、Memory、Runtime、SkillPort、ReplyStore 和持久化绑定串成一条可验证的候选回复流程，并用稳定测试证明模块边界、联系人隔离、候选依据和失败闭环已经落实。

**Blocked by:** 03 — 建立联系人范围内的 Context、Retrieval 与 Memory 证据链；04 — 收敛 ReplyStore 的幂等与候选生命周期；05 — 持久化已验证会话绑定；06 — 接入 PostgreSQL ReplyStore；07 — 接入 PostgreSQL SkillPort。

**Status:** 已完成候选回复端到端边界验收。

- [x] 有效绑定下的目标消息回复和草稿改写都能从统一入口完成 Context → Runtime → Store，并返回已持久化候选。
- [x] 未确认、失配、低置信度、撤销绑定和跨联系人请求在下游调用前被阻止。
- [x] 消息与关系记忆只通过 Retrieval 进入 Context；Runtime 不直接动态检索，改写要求不沉淀为长期偏好。
- [x] 重放、冲突、失败重试、显式候选继续、依据引用和 Skill 版本审计在真实持久化链路中通过验证。
- [x] 代码不提供外部聊天发送、OCR、桌面切换、网络、Shell、安装包或子 Agent Tool。
- [x] 完成项目规定的 unit、compile、数据库集成和 diff 检查，并如实记录仍未实现的桌面同步或真实模型能力。

## Answer

已完成候选回复端到端边界验收。本次没有新增生产模块，因为 #01～#07 已经提供了所需的
流程和 adapter；新增集成测试把它们从公共应用入口串起来：

1. `CandidateReplyFlow.execute` 使用真实 PostgreSQL 会话绑定验证；只有 `Ready` 才进入
   `ReplyGenerator`，再依次经过 `RetrievalReplyContext`、LangChain Runtime、PostgreSQL
   SkillPort 和 PostgreSQL ReplyStore。
2. 目标消息回复和 `RewriteDraft` 都通过同一个流程完成；改写只保存 `user_draft` 证据，
   默认不带入长期关系记忆，一次性改写要求只进入当前模型请求。
3. 真实持久化链路验证了候选保存后返回、Skill 实际版本、依据引用、同键冲突、完成重放、
   失败后同请求重试和用户显式继续候选。
4. 真实 PostgreSQL 会话边界验证了 ambiguous、low-confidence、revoked 和跨联系人请求均
   在 Runtime 前停止；模型没有获得发送 Tool。

验证结果：在 `notalone_conversation_test`（001-008 迁移）上，
`tests/integration` 48/48 通过，`tests/unit` 97/97 通过，`compileall` 和
`git diff --check` 通过。测试清理后 `owner`、`conversation_binding`、`reply_request`、
`reply_skill` 和 `reply_skill_version` 均为 0 行。

默认 `notalone_test` 的全量 123 个测试仍为 3 个既有失败、22 个既有 PostgreSQL schema
错误和 4 个跳过；该库仍停留在旧 001 schema，缺少 `channel_identity`、
`wechat_message_metadata`、`conversation_binding`、ReplyStore 和 SkillPort 表，不能作为本次
#08 代码回归依据。

剩余边界：消息和关系记忆本次仍通过已有 `InMemoryRetrieval`/`InMemoryMemoryStore` 合成
adapter 提供，仓库尚未实现 PostgreSQL Retrieval/Memory adapter；真实模型、UI、桌面观察、
OCR、前台同步和手动发送链路也未接入。当前 Reply public contract 的 Skill 选择方式、原因和
置信度字段仍待单独审计合同任务，不由本次端到端测试臆造。
