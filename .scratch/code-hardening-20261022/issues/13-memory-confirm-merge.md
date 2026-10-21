# 13 confirm 事务合并

Triage: ready-for-agent
State: open

## 目标

`memory_store.confirm` 与 `owner_memory_store.confirm_candidate` 的复制事务收敛为共享实现；`expected_dimension_evidence` 校验时点统一，消除重复来源查询。

## 证据

- `memory_store.py:490`（233行）vs `owner_memory_store.py:166`（265行）结构逐段相同。
- owner 版在幂等重放前校验 expected_dimension_evidence；contact 版只在新分支；contact 版 `_ensure_active_sources` 重复 3 次。
- 复核：`verify-backend.md` A6。

## 范围

- 抽公共 `_confirm_candidate_in_transaction`（或等价），两个 store 薄包装；统一校验时点（fail-closed，重放也校验）。
- 保留两侧独有规则（如 owner `FactSubject is SELF` 拒绝）。
- 不改写删除/来源/版本语义；事务边界不变。
- 测试：现有记忆确认/重放/陈旧证据测试全绿 + 新增「重放时证据变化」两侧一致用例。

## 验收

- 记忆相关单测/集成；报告确认路径行为差异点。

## Comments
