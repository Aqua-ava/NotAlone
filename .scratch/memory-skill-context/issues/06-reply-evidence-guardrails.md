# 06 — 候选回复安全校验与追踪

**What to build:** 用户从完整的 Memory、L0 Tool 和 Skill 链路得到候选回复时，系统能确认候选只使用了当前联系人本轮真实读取的资料，并向用户展示依据和 Skill；任何越权、旧版本、无来源或异常结果都会被拒绝或安全回退。

**Blocked by:** 04 — L0 Tool 结果；05 — Skill 目录和按需加载。

**Status:** ready-for-agent
**State:** resolved
**Triage:** ready-for-agent

- [x] 候选回复输出包含文本、依据引用、可选 Skill 标识/版本和必要的不确定性或风险信息。
- [x] 程序拒绝不存在于本轮上下文、跨联系人、已删除、已失效或版本不一致的依据。
- [x] 生成前和生成后都校验 `owner_id + contact_id`、来源状态、记忆 revision 和 Skill revision。
- [x] L0/L1 内容保持数据/证据语义，不能覆盖系统规则、用户当前要求或 Tool 权限。
- [x] 应用内可以查看本轮使用的依据和 Skill，但普通日志不保存完整 Prompt、聊天原文或 Skill 正文。
- [x] 记录最小检索轨迹、引用 ID、Tool 状态、Skill 版本、延迟和用量，且遵守现有隐私及删除生命周期。
- [x] Tool 失败、Skill 失败、结构化输出失败或上下文超限时有确定性回退，不触发外部发送。
- [x] 候选只在应用内展示；用户修改并亲自发送，Agent 没有聊天发送 Tool。
- [x] 通过主测试 Seam 验证正常、越权、删除、冲突、异常和回退行为。

## Answer

已在 `ReplyGenerator` 的生成前后增加上下文新鲜度校验：消息和确认记忆会重新读取当前联系人范围内的来源、状态、有效期、正文和 revision，记忆目录与 Skill 目录 revision 变化会使本轮候选确定性拒绝。结构化候选、引用、Tool 轨迹、Skill 使用记录和 Runtime 用量也在模型边界重新校验；无效结果不会落库，更不会进入外发路径。

回复快照保留最小化的证据 ID、来源 ID、状态、时间和 revision，现有 App payload 可展示候选依据、风险和 Skill 摘要；普通 outbound ledger 只记录范围、结果、模型用量和延迟，不记录完整 prompt、聊天正文或 Skill 内容。删除或失效后的证据在生成前/后均会被拒绝，发送能力仍不存在。

验证：`python -m compileall -q src tests`；82 个相关 unit/integration 测试通过；`git diff --check` 通过。测试只使用合成数据；未执行真实聊天发送或生产数据库操作。
