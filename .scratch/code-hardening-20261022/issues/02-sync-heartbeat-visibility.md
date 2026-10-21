# 02 同步心跳失败状态投影

Triage: ready-for-agent
State: open
Blocked by: 01

## 目标

SyncHost 心跳/开关心跳失败时不再「显示开着、实际停读」：失败写入可查询状态（失败码+时间），`/api/sync/status` 能区分「用户关闭」「读开关失败」「本轮 cycle 失败」，并记 warning。

## 证据

- `backend/src/notalone/server/sync_host.py:553-597`：`sync_enabled()` 异常按关闭处理；`_run_cycle_guarded` 吞整轮异常 `return None`，不更新 `_latest`。
- `app.py:762-778` 的 `/api/sync/status` 直接回 `sync.status()`，旧报告继续显示 ACTIVE。
- 复核：`verify-backend.md` A2。

## 范围

- `sync_host.py`：新增心跳失败状态字段（如 `sync_health`/`failure_code`），失败保留原文不泄露；读取开关失败不复用「用户关闭」语义。
- 状态 payload 增加失败信息（只加字段，不改既有字段含义）。
- 测试：fake engine 在 `sync_enabled`/`cycle` 抛错，断言 status 有失败码、日志 warning、不伪造 ACTIVE。

## 验收

- 单测 + 相关 server 集成测试；报告数据影响（状态字段新增对桌面调用方的影响）。
- 若桌面状态投影需要同步展示，拆到 05/07 或新 ticket，不扩大本 ticket。

## Comments
