# 记忆召回第一期设计草案

> 状态：草案；正式决定见 ADR-028
> 日期：2026-09-17
>
> 本文记录已经确认的第一期实现设计，不代表对应代码已经实现；实现完成后回填 `architecture/current/`。

## 1. 目标与边界

让回复上下文按当前正文召回相关的联系人记忆与本人记忆，行为可解释、有阈值、有预算、可复验。

不做：向量与 embedding、LLM 查询计划、待确认候选注入、抽取与采纳改动、PostgreSQL 全文检索扩展、macOS 界面改动。

## 2. 数据流

```text
当前正文（reply_to_message 的待回复消息 / rewrite_draft 的草稿）
  -> 截取前 200 字符并分词去重
  -> L1 候选：联系人 list_confirmed(scope)；本人 list_active(owner_id)
  -> 覆盖率评分（同一评分器）
  -> 阈值 0.15 过滤
  -> 词典序排序
  -> 双预算截断
  -> 证据：kind=confirmed_memory / owner_memory
```

## 3. 分词与评分公式

- CJK 连续段（`[\u4e00-\u9fff]+`）：unigram 权重 0.5、bigram 权重 1.0；
- 拉丁字母与数字：小写后按词，权重 1.0；标点与空白只作分隔；
- query 与记忆正文使用同一分词器，命中要求 token 完全相等；
- query token 去重；`score = 命中 token 权重和 / query 全部 token 权重和`；
- `score >= 0.15` 才进入候选；query 无 token 或无命中时注入 0 条；
- 评分器为纯函数模块（tokenizer + scorer），Postgres 与 InMemory 适配器共用；
- 常量固化在模块内，不做运行时配置。

## 4. 排序

1. `relevance_score` 降序；
2. `adoption_method=manual` 优先；
3. `confidence` 降序；
4. `valid_at` 降序（NULL 最后）；
5. `memory_id` 升序（稳定序）。

`selection_reason` 记录分数、命中 token 和排序因素；随回复快照落库。

## 5. 双预算

| 范围 | 条数 | 字符 |
| --- | --- | --- |
| 联系人记忆 | ≤ 5 | ≤ 600 |
| 本人记忆 | ≤ 3 | ≤ 240 |

字符口径 `len(text)`；不截断单条正文；按排序累加，第一条放不下即停止；两侧使用同一评分器与阈值。

## 6. 目录角色

- 召回候选不再调用 `locate_memory_ids`；`contact_memory_index` 只提供 `revision_snapshot` 供生成前后复验；
- `memory_ids` 参数保留给复验路径；`query=None` 时不评分、不改变现有复验行为。

## 7. 证据与提示

- `ContextEvidence.kind` 增加 `owner_memory`；
- 本人证据仍带当前 `ContactScope`（只表会话可见性）；`validate_current` 只按 `owner_id` 重新读取并校验存在性、来源、状态、有效期与 revision；
- `search_owner_memories` 需要增加 `memory_ids` 参数，并复用同一评分器与排序；
- 提示证据顺序：消息 → 联系人记忆 → 本人记忆 → 继续候选；本人证据带清晰标签，避免与联系人事实混淆；
- `rewrite_draft` 打开 `include_relationship_context` 时同时注入两类记忆；判定方法覆盖 `owner_memory`；
- 生产 `reply_wiring` 需要把 `OwnerMemoryStore` 接入 `PostgresRetrieval`；
- 迁移 033 放宽 `reply_context_evidence.kind` 的 CHECK，允许 `owner_memory`。

## 8. 评测与门槛

用例字段参考抽取评测：维度、query、联系人范围、记忆列表（正文/分类/主题/采纳方式/置信度/有效期/来源）、期望召回、期望排除、预算参数。

运行方式：`InMemoryRetrieval` + 真实评分器与真实 `RetrievalReplyContext`，纯离线、无模型凭据、断言进 CI。

维度与门槛（每维度 ≥ 15 例）：

| 维度 | 门槛 |
| --- | --- |
| 直述命中 | top-5 命中率 ≥ 90% |
| 改写命中 | ≥ 60% |
| 无关拒绝 | 误注入 0 |
| 跨联系人隔离 | 泄漏 0 |
| 失效 / 已删除 | 注入 0 |
| 预算 | 超限 0，双预算独立 |
| 排序 | 优先级正确率 ≥ 90% |

不达标先调词法与阈值，不得放宽门槛；标定结果记 `docs/memory-recall-evaluation-baseline.md`。

## 9. 涉及改动

- 新增纯函数评分模块与单元测试；
- `PostgresRetrieval` / `InMemoryRetrieval`：`search_confirmed_memories` 使用评分器；`RetrievedMemory` 增加 `relevance_score`、`matched_terms`；
- `search_owner_memories`：复用评分器，增加 `memory_ids`；
- `RetrievalReplyContext`：query 传递、阈值、排序、双预算、owner 证据与复验；
- `reply_wiring`：接入 `OwnerMemoryStore`；
- 迁移 033；
- 召回评测用例、runner 与 baseline 文档。

## 10. 风险

- 纯词法对同义改写漏检，由改写维度门槛暴露；只有评测证明不足时才按 ADR-005 第 5 节评估向量补充；
- 阈值 0.15 与预算数值是标定起点，标定后固化并记录证据；
- 旧候选缺少主体信息的问题已由迁移 032 兜底，与本期无关。
