# 12 共享上下文校验

Triage: ready-for-agent
State: open

## 目标

三份 `_validate_context` 收敛为一个纯函数/共享实现，generator、Postgres reply store、InMemory store 只做薄包装，规则不再漂移。

## 证据

- `reply/generator.py:342`（约162行）、`persistence/reply_store.py:896`（约157行）、`reply/store.py:546`（约133行）。
- 三份各有独有不变量：按输入模式、require_explored_context + assistant_discussion + 回表比对、InMemory 缺一组。
- 复核：`verify-backend.md` A5。

## 范围

- 抽出 `reply/context_validation.py`（或同等 seam）纯函数：输入 command/context/读候选回调，输出校验结果；per-mode 不变量并入。
- 三处改薄包装；InMemory 不再缺规则。
- 不改写业务规则本身；若发现规则冲突，记录在 Comments 并按更严格一侧统一（fail-closed）。
- 测试：现有 reply 校验/越权相关测试全绿 + 新增三实现一致性参数化测试。

## 验收

- reply 相关单测/集成；报告行为差异点与统一依据。

## Comments
