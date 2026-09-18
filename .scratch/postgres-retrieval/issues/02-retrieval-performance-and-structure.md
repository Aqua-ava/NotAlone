# 检索层性能与结构缺口（第二轮审查）

Triage: needs-triage
State: open

## 背景

2026-09-18 第二轮只读审查发现，检索正确性无碍但性能/结构有三处缺口。

## 缺口

1. **无可索引的全文路径，且超时默认关闭**（`persistence/retrieval.py:32-37,333-337,560-566`）：token 匹配用 `position(lower(...) in lower(CASE ...)) > 0`，每 token 一个不可索引谓词，只能顺序扫描（O(行数 × token 数)）；schema 无 tsvector/GIN 索引（已核对全部 migration）；`timeout_ms=None` 缺省时不设置任何 `statement_timeout`，模块预算（≤1500ms）在默认路径完全不生效。
2. **`message_stream` 引用视图解析不确定**（`message_stream.py:109-127`）：`LEFT JOIN LATERAL (... FROM message_source_ref ... LIMIT 1)` 无 ORDER BY，多来源引用且 quote payload 分布不均时，被选中的 ref 恰好带 quote 与否取决于执行计划——引用视图静默丢失且翻页间可能不稳定。建议偏好携带 quote payload 的 ref（ORDER BY + LIMIT 1）。
3. **`outbound_ledger.list_by_owner` 无界查询**（`outbound_ledger.py:26-40,82-90`）：按 owner 全量拉取，无 LIMIT/分页/时间窗；台账只增不删。

## 为什么测试没抓到

检索集成测试数据集极小，性能与超时路径无断言；`PostgresMessageStream` 无持久层集成测试（application 层用 stub）；ledger 测试仅少量记录。

## 约束

性能改动必须先建立基线测量（见 engineering.md 性能分支：先测量再修改）；涉及检索契约需对照 `docs/agents/domain.md` 的检索领域文档。

## Comments
