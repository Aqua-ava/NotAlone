# 02 — 待确认候选参与回复（证据类型、理由落库、界面展示）

**What to build:** 让待确认候选可以作为候选回复的参考，但必须带未确认标注，不得写成确定事实。实现范围：回复链路的证据类型（如 `pending_reference`）、候选生成时的解释理由与状态标签落库、界面展示与用户确认/否决路径；确认后转为正式记忆，否决后不得再参与。

**Triage:** ready-for-agent
**State:** claimed
**Blocked by:** 无（ADR-027 已确认方向；实现属新纵切）

- [ ] 待确认候选作为证据时强制带未确认标注，回复文本不得写成确定事实
- [ ] 解释理由与语用状态（pending 原因）随候选落库并可查看
- [ ] 用户确认/否决路径完整，否决后不再参与回复
- [ ] 记忆候选生命周期测试覆盖：候选→待确认→确认/否决→检索可见性

## Comments

- 2026-10-05：用户明确选择「能，但必须标『未确认』」——待确认候选可以参与候选回复，但证据必须强制带未确认标注、回复文本不得写成确定事实；用户否决过的候选永久不再参与。同轮用户还确认了票 03「只有测准的类型自动记」、票 05「短期消息存但到期自动失效」、票 04「安排一次真机冒烟」；票 01 方向为「继续投入」，具体调用预算另行逐次批准。`Triage` 保持 ready-for-agent，`State` 由 open 改为 claimed，开始按 `docs/agents/workflow.md` 的实现流程推进。
- 2026-10-05（后端纵切第一遍，不含 macOS 界面）：新增第 6 种证据类型 `pending_candidate` 与独立检索入口 `RetrievalPort.search_pending_candidates`（内存与 PostgreSQL 各一份，数据源为既有 `list_pending_candidates`），独立预算 3 条/300 字符、沿用 0.15 阈值；强制未确认标注写入 `selection_reason` 并随 `status` 透传给模型，`BASE_SYSTEM_PROMPT` 明确禁止表述为确定事实；只在允许历史证据的请求注入，`has_unauthorized_history` 计入新类型；`validate_current` 新增独立分支，候选被确认／否决／失效、越界、过期、来源不可用或正文来源变化时拒绝本轮；迁移 `037_pending_candidate_evidence_kind.sql` 放宽 `reply_context_evidence.kind`，ADR-035 显式修订 ADR-005／ADR-011／ADR-028 的绝对表述并同步 `core-flows.md` 与 ADR 索引。验证：全量 unit 837 项通过；`tests/unit/reply` 160、`tests/unit/retrieval` 87、`tests/unit/memory` 9 项通过；集成 `tests/integration/reply` 8 项、`tests/integration/server` 151 项、`tests/integration/persistence` 298 项通过（全量集成 515 项中 `DatabaseAdoptionTest` 会偶发既有的 `adoption_writers_present` 时序失败，隔离运行 23 项通过）；`mypy` 与改动前同样为 59 项既有问题，未新增。**未完成（留给第二遍）**：macOS Swift 界面展示未确认标注与候选确认／否决入口；本票未 `resolved`。
