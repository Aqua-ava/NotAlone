# 02 — 联系人记忆相关性召回

**What to build:** 回复上下文按当前正文只注入相关联系人记忆。待回复消息正文或改写草稿正文作为 query；检索适配器用共享评分器对当前有效的联系人记忆评分，按词典序排序（相关性、manual 优先、置信度、valid_at、稳定 ID）；低于阈值 0.15 不注入；最多 5 条且合计不超过 600 字符，不截断单条正文；无相关记忆时回复正常生成；`selection_reason` 记录分数、命中词与排序因素。联系人记忆目录不再参与候选过滤，只保留生成前后的 revision 复验；按 `memory_ids` 复验路径保持可用。

**Triage:** ready-for-agent
**State:** resolved
**Blocked by:** 01 — 共享中文词法评分模块

- [x] 待回复消息与改写草稿正文都会作为 query；改写仅在开启关系资料时检索
- [x] 无关正文不注入记忆；查询词法无命中时 `evidence` 只含消息等非记忆证据
- [x] 超过 5 条按排序截断，按字符预算累加，第一条放不下即停止，单条正文不截断
- [x] 排序在相关性相同时按 manual、confidence、valid_at、memory_id 依次裁决
- [x] 目录命中为空或过期不再吞掉候选；目录仅参与 revision 复验
- [x] 内存与 PostgreSQL 适配器使用同一评分器，行为一致
- [x] `selection_reason` 含分数与命中词，随回复快照落库
- [x] 现有回复上下文、检索与 PostgreSQL 集成测试全部通过

## Comments

## Answer

- 实现：新增召回排序模块（`recall_memories`/`rank_memories`），两个适配器共用同一路径：`query=None` 保持复验语义不评分，提供 query 时按覆盖率评分，query 无 token 直接返回空。`RetrievedMemory` 增加 `confidence`、`relevance_score`、`matched_terms`；回复上下文以当前正文为 query，应用阈值 0.15 与常量预算（联系人 5 条/600 字符，`CONTACT_MEMORY_LIMIT`/`CONTACT_MEMORY_CHAR_BUDGET`），首条放不下即停止；`selection_reason` 记录分数、命中词与排序因素；目录退出候选过滤，只保留 revision 快照复验；`memory_ids` 复验路径不变。
- 审查修复：两轴 code review 发现并修复——无 token query 曾回退返回未评分记忆导致误注入（现返回空）；补全入选原因的排序因素；预算提升为模块常量；适配器尾部重复逻辑收敛到 `recall_memories`。
- 验证：`python -m unittest tests.unit.retrieval.test_ranking tests.unit.reply.test_context_retrieval` 35 项通过；全量 873 项通过、3 项跳过；PostgreSQL 集成新增 2 项（评分排序、复验无分数）；`python -m mypy --follow-imports=silent` 对变化文件无问题（`persistence/retrieval.py` 2 项与 `test_context_retrieval.py` 5 项为既有类型缺口）。
- 数据影响：只读检索路径，无写入、无外部调用；测试全部合成数据。
- 剩余风险：同义改写漏检由票 04 度量；阈值与预算待票 05 标定；空字符串 query 语义收紧为“无 token 即不召回”，与旧适配器行为不同但符合规格。
