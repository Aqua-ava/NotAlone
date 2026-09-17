# 06 — 回填架构 current 文档

**What to build:** 实现完成后把已经落地的召回行为回填 `architecture/current/` 对应规格，使现行文档反映实际实现；把 `architecture/drafts/recall-phase-1.md` 标记为已收束并指向正式决定；核对 ADR-028 与实现无冲突，遗留项（如向量补充评估条件）保持记录。

**Triage:** ready-for-agent
**State:** resolved
**Blocked by:** 05 — 标定基线与常量固化

- [x] `architecture/current/` 反映实际实现的查询、评分、阈值、双预算与证据类型
- [x] 草案标记已收束，不再作为未决设计
- [x] ADR-028 与实现无冲突；遗留的向量补充条件仍可追溯

## Comments

## Answer

- 回填：`architecture/current/core-flows.md` 的轨三与预算章节改为当前实现（当前正文词法评分、阈值 0.15、联系人 5 条/600 字符与本人 3 条/240 字符独立预算、目录只做 `memory_revision` 复验），并链接评测基线；`architecture/current/domain-data.md` 的记忆自动维护机制、目录契约和 `owner_preference` 数据行更新为已实现的召回路径与“本人记忆”术语。
- 收束：`architecture/drafts/recall-phase-1.md` 标记为已收束，指向 ADR-028 与评测基线；向量补充评估条件保留在 ADR-005 第 5 节与 ADR-028 第 7 节。
- 核对：ADR-028 各决策与代码、测试和文档一致；未发现需要新 ADR 的冲突。
- 验证：全量 899 项通过、3 项跳过；本次仅文档改动，无代码变更。
- 剩余风险：真实分布召回质量仍由改写维度与后续真实使用反馈观测，不因文档回填而得到证明。
