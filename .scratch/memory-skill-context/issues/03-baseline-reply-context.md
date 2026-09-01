# 03 — 基础 ReplyContext 与每轮 Prompt

**What to build:** 用户针对已确认联系人生成候选回复时，系统通过一次新的上下文快照提供当前消息、最近完整对话和少量相关 L1/L2；无关历史不会混入，下一次请求不会沿用上一轮的隐藏上下文。

**Blocked by:** 01 — 关系记忆采纳规则；02 — L2 目录及其 revision/失效语义。

**Status:** ready-for-agent
**State:** resolved
**Triage:** ready-for-agent

- [x] 候选回复使用当前 Message、有限的最近完整对话和当前联系人相关的有效 `confirmed_memory`。
- [x] L2 只作为当前场景的导航或少量提示，不把全量 L2 或历史 L0 注入初始 Prompt。
- [x] 历史 L0 默认不进入初始 Prompt；初始上下文只包含当前任务需要的资料。
- [x] 每次候选回复都重新校验联系人、来源和 revision，并生成独立的 `ReplyContext` 快照。
- [x] 每项进入上下文的资料带来源 ID、状态、有效期和入选原因，且所有资料属于当前联系人。
- [x] 空检索或基础检索失败时，系统只使用当前消息和最近对话继续，不能编造历史事实。
- [x] 通过候选回复生成入口验证从请求到可展示候选的外部行为，不依赖具体 Prompt 字符串或数据库查询实现。

## Answer

已完成基础 ReplyContext 与每轮上下文快照：

1. ReplyContext 以当前待回复 Message 为锚点，带有限近期消息和当前联系人有效 confirmed_memory；L2 只返回 ID 导航，正文仍从 L1 权威检索，历史 L0 不进入初始上下文。
2. 上下文证据保存来源 ID、状态、有效期、入选原因和记忆 revision；快照记录当前记忆 revision 与目录 revision，并在 ReplyGenerator、两种 ReplyStore 入口统一校验。
3. 关系记忆为空或基础检索失败时只降级为当前消息/近期消息；越权结果、坏版本或错误证据结构仍 fail-closed。新增 028 迁移保存 ReplyContext 证据元数据。

验证：相关单元测试 41 个通过；ReplyStore/Reply flow/Contact Memory Index 集成测试 18 个通过；`python -m compileall -q src tests` 与 `git diff --check` 通过。上下文仅保存本轮最小证据元数据，未新增历史 L0 全量复制或发送能力。
