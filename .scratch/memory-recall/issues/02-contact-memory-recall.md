# 02 — 联系人记忆相关性召回

**What to build:** 回复上下文按当前正文只注入相关联系人记忆。待回复消息正文或改写草稿正文作为 query；检索适配器用共享评分器对当前有效的联系人记忆评分，按词典序排序（相关性、manual 优先、置信度、valid_at、稳定 ID）；低于阈值 0.15 不注入；最多 5 条且合计不超过 600 字符，不截断单条正文；无相关记忆时回复正常生成；`selection_reason` 记录分数、命中词与排序因素。联系人记忆目录不再参与候选过滤，只保留生成前后的 revision 复验；按 `memory_ids` 复验路径保持可用。

**Triage:** ready-for-agent
**State:** open
**Blocked by:** 01 — 共享中文词法评分模块

- [ ] 待回复消息与改写草稿正文都会作为 query；改写仅在开启关系资料时检索
- [ ] 无关正文不注入记忆；查询词法无命中时 `evidence` 只含消息等非记忆证据
- [ ] 超过 5 条按排序截断，按字符预算累加，第一条放不下即停止，单条正文不截断
- [ ] 排序在相关性相同时按 manual、confidence、valid_at、memory_id 依次裁决
- [ ] 目录命中为空或过期不再吞掉候选；目录仅参与 revision 复验
- [ ] 内存与 PostgreSQL 适配器使用同一评分器，行为一致
- [ ] `selection_reason` 含分数与命中词，随回复快照落库
- [ ] 现有回复上下文、检索与 PostgreSQL 集成测试全部通过

## Comments

## Answer
