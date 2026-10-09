# 02 — 向量候选导航与本地权威复验

> Triage: ready-for-agent
> State: resolved
> Blocked by: 01
> 规格：[原 PostgreSQL＋pgvector 记忆召回隔离评估](../spec.md)

## 交付行为

实现实验专用候选导航适配器：向量查询只返回本地 `memory_id` 候选，随后回到现有权威记忆读取路径，校验联系人范围、active 状态、有效期、有效来源和当前 revision，再按既有 `RetrievedMemory` 结构返回。

## 验收

- [x] `owner_id + contact_id` 在向量查询前置过滤，且候选不能跨范围。
- [x] deleted、invalidated、过期、无有效来源和旧 revision 候选全部拒绝。
- [x] 多候选 chunk 或重复向量按本地 memory ID 去重，正文和来源来自本地权威记录。
- [x] 空 query、阈值拒绝、映射异常和数据库错误有可观察的诊断与失败分母。
- [x] 本人记忆、消息检索、`query=None` 和显式 `memory_ids` 继续走现有路径。
- [x] 单元测试覆盖范围、状态、来源、revision、去重和异常行为。

## Answer

已完成实验性 `PgVectorCandidateRetrieval`。向量层只返回候选身份，适配器按 owner＋contact、active、有效期、来源和当前 revision 回读本地权威记忆；重复候选按 memory ID 合并，消息、本人记忆、`query=None` 和显式 ID 继续委托现有路径。增加了越界候选、坏类型候选、候选预算、删除、失效、过期、旧 revision、跨范围和诊断状态测试。

验证：`PYTHONPATH=src python -m unittest tests.unit.experiments.test_pgvector_adapter -v`，12 项通过。收尾补齐了两项覆盖：未来生效时间（`valid_at` 在将来）候选被 `local_authority` 拒绝，以及显式 `memory_ids`、本人记忆、消息与上下文消息检索全部委托且不触发向量调用。无来源记录已由 `ConfirmedMemory` 与 `RetrievedMemory` 的构造校验挡住，适配器的 `source_ids` 检查只是防御性兜底。

实现口径说明：无 token 的 query 记录 `status="success"` 并返回空结果，不调用向量层也不委托本地路径；`below_tau`/`mapping`/`scope`/`revision`/`local_authority` 拒绝原因全部进入 `last_attempt` 诊断，向量层异常记为 `status="failure"` 后重新抛出，由评测层保留在失败分母中。数据库错误与失败分母目前只有代码路径和集成轮次证据，没有单元用例（见 03/04 的限制记录）。

## Comments

- 2026-10-04：实现完成并标记 resolved；验收由主 Agent 复核代码与实跑证据后逐项确认。
- 2026-10-04：收尾复查补齐 future `valid_at` 与委托路径测试；数据库错误、失败分母仍无单元用例，已在 Answer 与报告中列为限制。
