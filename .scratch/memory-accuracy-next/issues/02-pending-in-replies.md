# 02 — 待确认候选参与回复（证据类型、理由落库、界面展示）

**What to build:** 让待确认候选可以作为候选回复的参考，但必须带未确认标注，不得写成确定事实。实现范围：回复链路的证据类型（如 `pending_reference`）、候选生成时的解释理由与状态标签落库、界面展示与用户确认/否决路径；确认后转为正式记忆，否决后不得再参与。

**Triage:** ready-for-agent
**State:** resolved
**Blocked by:** 无（ADR-027 已确认方向；实现属新纵切）

- [x] 待确认候选作为证据时强制带未确认标注，回复文本不得写成确定事实
- [x] 解释理由与语用状态（pending 原因）随候选落库并可查看
- [x] 用户确认/否决路径完整，否决后不再参与回复
- [x] 记忆候选生命周期测试覆盖：候选→待确认→确认/否决→检索可见性

## Comments

- 2026-10-05：用户明确选择「能，但必须标『未确认』」——待确认候选可以参与候选回复，但证据必须强制带未确认标注、回复文本不得写成确定事实；用户否决过的候选永久不再参与。同轮用户还确认了票 03「只有测准的类型自动记」、票 05「短期消息存但到期自动失效」、票 04「安排一次真机冒烟」；票 01 方向为「继续投入」，具体调用预算另行逐次批准。`Triage` 保持 ready-for-agent，`State` 由 open 改为 claimed，开始按 `docs/agents/workflow.md` 的实现流程推进。
- 2026-10-05（后端纵切第一遍，不含 macOS 界面）：新增第 6 种证据类型 `pending_candidate` 与独立检索入口 `RetrievalPort.search_pending_candidates`（内存与 PostgreSQL 各一份，数据源为既有 `list_pending_candidates`），独立预算 3 条/300 字符、沿用 0.15 阈值；强制未确认标注写入 `selection_reason` 并随 `status` 透传给模型，`BASE_SYSTEM_PROMPT` 明确禁止表述为确定事实；只在允许历史证据的请求注入，`has_unauthorized_history` 计入新类型；`validate_current` 新增独立分支，候选被确认／否决／失效、越界、过期、来源不可用或正文来源变化时拒绝本轮；迁移 `037_pending_candidate_evidence_kind.sql` 放宽 `reply_context_evidence.kind`，ADR-035 显式修订 ADR-005／ADR-011／ADR-028 的绝对表述并同步 `core-flows.md` 与 ADR 索引。验证：全量 unit 837 项通过；`tests/unit/reply` 160、`tests/unit/retrieval` 87、`tests/unit/memory` 9 项通过；集成 `tests/integration/reply` 8 项、`tests/integration/server` 151 项、`tests/integration/persistence` 298 项通过（全量集成 515 项中 `DatabaseAdoptionTest` 会偶发既有的 `adoption_writers_present` 时序失败，隔离运行 23 项通过）；`mypy` 与改动前同样为 59 项既有问题，未新增。**未完成（留给第二遍）**：macOS Swift 界面展示未确认标注与候选确认／否决入口；本票未 `resolved`。
- 2026-10-06：第二遍（macOS 界面）已完成并提交 `dc3579d`，本票四条验收全部落实，`State` 改为 `resolved`；详细依据见上方 Answer。
- 2026-10-06：核对第二遍的落地范围与证据后收口。本轮只做票面核对与状态订正，未改动任何产品代码或测试。

## Answer

**已完成**（后端 `e6bc273`，macOS 界面 `dc3579d`，均在本地，无远端推送）：

1. **强制未确认标注**：新增第 6 种证据类型 `pending_candidate` 与独立检索入口 `RetrievalPort.search_pending_candidates`（内存与 PostgreSQL 各一份），独立预算 3 条／300 字符、阈值 0.15；未确认标注写入 `selection_reason` 并随 `status` 透传给模型，`BASE_SYSTEM_PROMPT` 明确禁止表述为确定事实。前端另设纯函数 `ReplyEvidencePresentationPolicy`：`pending_candidate` 一律显示「未确认 · 仅供参考」橙色标注，不套用任何已确认标签，也不展示只属于已确认资料的时间行。
2. **理由与状态落库可查看**：候选的 `status` 与 `selection_reason` 随回复证据持久化，迁移 `037_pending_candidate_evidence_kind.sql` 放宽 `reply_context_evidence.kind`；ADR-035 显式修订 ADR-005／ADR-011／ADR-028 的绝对表述，并同步 `core-flows.md` 与 ADR 索引。App 侧展示候选的模型置信度与风险标记。
3. **确认／否决路径完整**：后端 `validate_current` 新增独立分支，候选被确认／否决／失效、越界、过期、来源不可用或正文来源变化时拒绝本轮；`tests/unit/retrieval/test_pending_candidate_recall.py` 的 `test_rejected_candidate_stays_invisible_after_rejection` 钉住「否决后不再可检索」。App 侧 `AppModel.confirmPendingCandidate`／`discardPendingCandidate` 走既有确认与删除端点，成功后立即撤下该候选的旧回复依据并重读待确认列表（区分「空列表」与「未读到」，快照状态缺失或非 `pending` 时保留候选身份但隐藏正文，fail-closed）。
4. **生命周期测试覆盖**：`test_pending_candidate_recall.py` 11 项覆盖仅待确认候选可见、永不进入已确认轨、否决后不可见、过期／未生效候选被丢弃、范围与预算边界；`tests/unit/reply/test_pending_candidate_context.py` 覆盖回复上下文的注入与拒绝；App 侧新增 13 项策略单测覆盖未确认标注、fail-closed 与草稿模式无占位。

**验证（本票收口时实际运行）**：`python -m unittest discover -s tests/unit -t .` 931 项全部通过；`swift test --package-path macos_app` 79 项全部通过（含 13 项展示策略测试）；`git status` 干净、HEAD `c66f1e3`。

**限制（如实保留）**：① macOS 界面只做到编译与 Core 层策略测试，本机无法运行 App 做界面点击验证，确认／否决按钮的真实交互未经人工点击确认；② 待确认候选进入回复的证据质量只由合成用例与单元测试证明，未做真实模型端到端评测；③ 自动采纳侧的收紧独立于本票，见票 03（默认放行表为空，所有候选待确认）。

**数据影响**：只读核对代码、测试与票面；未连接数据库、未读取 `.env` 或真实聊天、未运行真实模型、未写入业务记忆。
