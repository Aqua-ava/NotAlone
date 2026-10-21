# 04 回复依据降级可见

Triage: ready-for-agent
State: open

## 目标

回复依据读取失败不再被当成「没有资料」：分层资料/关系概览读取异常记 warning，并在 ReplyContext/回执中与「确实没有」区分。

## 证据

- `backend/src/notalone/reply/context.py:600-606`（`capture` 异常 → snapshot=None）、`:663-670`（`read_contact/read_owner` 异常 → None）。
- `ContextReceipt`（`reply/interface.py:236-241`）不暴露 retrieval 失败。
- 复核：`verify-backend.md` A4。

## 范围

- `context.py`：异常路径 `logger.warning(exc_info=True)`；新增明确状态（如 `layered_status="read_failed"`、概览读取失败标记），不改写既有 `quality_closed/not_allowed/loaded/unavailable` 含义。
- `interface.py` 回执：暴露读取失败状态（只加字段）。
- 桌面是否展示留到后续，不在本 ticket 扩大。
- 测试：fake layered/overview 抛错，断言状态与日志；正常空资料仍为 `unavailable`/现有语义。

## 验收

- 单测 + reply 相关模块；报告新增字段对既有序列化/桌面解析的兼容性。

## Comments
