# 原 PostgreSQL＋pgvector 记忆召回隔离评估

> Triage: ready-for-agent
> State: resolved
> 日期：2026-10-04
> 来源：用户确认“只参考 Hindsight，不接入 Hindsight”，以及 Hindsight 合成对照后的下一步决定。

## 问题陈述

NotAlone 当前正式路径以联系人范围内的中文词法检索为主。Hindsight 的隔离实验说明，语义候选可能找回词面不同的关系记忆，但服务重排耗时超过当前一秒目标。需要评估同一类语义补充能力能否直接建立在 NotAlone 原有 PostgreSQL 之上，并保持现有联系人、来源、删除、版本和上下文预算约束。

## 目标

在临时 PostgreSQL＋pgvector 环境中，对同一组合成已采纳记忆做 A/B 对照：A 复用现有词法基线；B 使用本地中文 embedding 和 pgvector 取候选 ID，再回到本地权威记忆读取与复验。结果只用于判断方案价值，不改变生产检索。

## 实现决定

1. **隔离范围**：只测 `confirmed_memory` 联系人记忆；不读取业务库，不读取真实聊天，不启用 Hindsight 服务，不修改正式迁移、生产依赖、feature flag 或 `reply_wiring`。
2. **向量职责**：实验表只保存 `memory_id`、`owner_id`、`contact_id`、`revision`、正文内容哈希、模型标识/维度和 embedding。向量表只做候选导航，不成为事实来源，也不复制新的关系事实。
3. **模型职责**：查询和记忆正文使用同一个本地中文 embedding 模型；本轮先固定 BGE-small-zh-v1.5 512 维。暂不加入 Hindsight 的重排服务；若需要重排，另立实验。
4. **权威复验**：候选必须按 `owner_id + contact_id` 查询当前 `confirmed_memory`，确认 `active`、有效期、有效来源和当前 `revision`，再返回既有 `RetrievedMemory`。删除、失效、过期和旧 revision 即使仍存在向量，也不能进入上下文。
5. **检索接缝**：B 只作为实验性 `RetrievalPort` 适配器或 runner 存在；`query=None`、显式 `memory_ids`、本人记忆和消息检索继续委托现有本地路径。正式回复装配不引用实验模块。
6. **校准与冻结**：只在独立 dev 集校准 cosine 阈值和候选规则；冻结后运行最终集，不能用最终结果回调阈值、gold 或数据。
7. **数据处理**：只使用已有合成数据集的匿名 UUID 和正文；实验结束按本轮 manifest 删除临时库、向量表、模型临时副本和产物中不需要的中间数据。embedding 视为从敏感文字派生的数据，报告删除边界。

## 验收标准

- 最终中文改写 Recall@5 相对现有词法基线至少提高 10 个百分点。
- 最终质量组无关注入率不高于现有路径；跨 owner、跨 contact、deleted、invalidated、过期和旧 revision 注入为零。
- 直接表达的召回单独报告，不能以改写收益掩盖明显退化。
- 预热后完整检索 P95 不超过 1,000 ms；计时包含 embedding、pgvector 查询、候选映射、本地权威复验和现有上下文选择。
- A/B 使用相同资料、查询、联系人范围、最终上下文预算和失败分母；空结果、失败和超时不从分母移除。
- 保存逐 query 结果、阈值、模型摘要、数据哈希、耗时分位数、清理证据和限制；实验结论不自动批准生产接入。

## 验证决定

- 单元测试：向量候选映射、同一 memory 去重、范围/状态/来源/revision 复验、阈值和空 query 行为、失败分母保留。
- 临时 PostgreSQL 集成验证：`CREATE EXTENSION vector` 能力探测、向量写入/近邻查询、HNSW 或精确查询、删除和旧 revision 不回流；失败时记录前提缺失，不连接业务库。
- A/B 评测：复用 `hindsight-synthetic-v2` 的冻结查询和 gold，但重新保存本实验模型、阈值和结果；开发集与最终集分离。
- 相关回归：既有词法检索、`RetrievalReplyContext`、联系人隔离、来源删除和上下文预算测试保持通过。

## 不在本次范围

- Hindsight 服务、Hindsight bank、Hindsight graph/reflect/mental model、LLM 提取或重排服务。
- 修改 `database/migrations/009_memory_store.sql`、`011_owner_memory.sql`、`018_contact_memory_index.sql`，或生产 `PostgresRetrieval`、`reply_wiring`、`pyproject.toml`、feature flag。
- owner memory、原始消息检索、自然聊天提取、回复生成质量和微信端到端行为。
- 把临时向量表升级为生产迁移，或在没有新的用户决策和隐私评审时开启正式向量路径。

## 完成条件

形成可复跑的隔离 runner、结果报告和清理证据；逐项报告是否达到验收标准。即使结果失败，只要运行前提、失败分母和限制完整记录，也可以形成有效的评估结论；不得把失败实验标成生产可用。

## Comments

- 2026-10-04：用户要求按工作流程推进；规格阶段保持“只参考、不接入产品”的边界。
- 2026-10-04：4 张实现任务全部 resolved，实验完成。最终结论为**未达到门槛**：中文改写 Recall@5 从 1.67% 提升到 26.39%，改写与质量组无关注入同时增加（质量组 15/95 → 36/95），P95 33.14 ms 通过 1,000 ms 门槛；跨 owner/contact、deleted、invalidated、过期和旧 revision 注入为零。收尾时修正了阈值候选网格取用 final 相似度的隔离违规（改为只用 dev 候选分值）并重跑，结果与报告在 `experiments/pgvector/REPORT.md`、`experiments/pgvector/runs/native-v3/result.json`。
- 2026-10-04：结论不批准生产接入；不修改迁移、依赖、`PostgresRetrieval`、`reply_wiring` 或 feature flag。
