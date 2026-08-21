# 08 — 完成候选回复端到端集成与边界验收

Type: task
State: open
Triage: ready-for-agent

**What to build:** 将外层会话验证、两种 Reply 输入、Context、Retrieval、Memory、Runtime、SkillPort、ReplyStore 和持久化绑定串成一条可验证的候选回复流程，并用稳定测试证明模块边界、联系人隔离、候选依据和失败闭环已经落实。

**Blocked by:** 03 — 建立联系人范围内的 Context、Retrieval 与 Memory 证据链；04 — 收敛 ReplyStore 的幂等与候选生命周期；05 — 持久化已验证会话绑定；06 — 接入 PostgreSQL ReplyStore；07 — 接入 PostgreSQL SkillPort。

**Status:** ready-for-agent

- [ ] 有效绑定下的目标消息回复和草稿改写都能从统一入口完成 Context → Runtime → Store，并返回已持久化候选。
- [ ] 未确认、失配、低置信度、撤销绑定和跨联系人请求在下游调用前被阻止。
- [ ] 消息与关系记忆只通过 Retrieval 进入 Context；Runtime 不直接动态检索，改写要求不沉淀为长期偏好。
- [ ] 重放、冲突、失败重试、显式候选继续、依据引用和 Skill 版本审计在真实持久化链路中通过验证。
- [ ] 代码不提供外部聊天发送、OCR、桌面切换、网络、Shell、安装包或子 Agent Tool。
- [ ] 完成项目规定的 unit、compile、数据库集成和 diff 检查，并如实记录仍未实现的桌面同步或真实模型能力。
