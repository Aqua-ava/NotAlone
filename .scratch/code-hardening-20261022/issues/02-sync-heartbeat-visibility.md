# 02 同步心跳失败状态投影

Triage: ready-for-agent
State: resolved
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

- 2026-10-22 完成：`SyncHost` 新增 `health()` 与 `SyncHeartbeatFailure(code, at)`；读开关失败记 `sync_switch_unavailable`（不再复用「用户关闭」），cycle 失败记 `sync_cycle_failed`，成功报告（`_cache_report_locked`）清除失败；warning 只记稳定错误码 + 异常类型名，不含异常正文。
- `/api/sync/status`：有报告时 payload 增加 `health` 字段；无报告时 503 错误体也带 `health`；不提供 `health()` 的旧端口保持原响应形状（`LegacySync` 测试）。
- 未改桌面状态投影（桌面解析只取已知字段，忽略多余字段）；后续如需 UI 展示可另立 ticket。
- 验证：`python -m unittest tests.unit.server.test_sync_host_health tests.unit.server.test_sync_status_health -v` 6 条通过；`python -m unittest discover -s tests/unit/server -t .` 97 条通过。
- 数据影响：无 schema/数据变更；状态 JSON 只新增字段。剩余风险：`health` 只反映后台心跳，用户手动 enable/check 失败仍走各自接口错误；异常类型名已足够区分但更细的原因需后续扩展错误码。
- Commit：见 `git log --grep '同步心跳失败'`。
- 2026-10-22 真机只读：`GET /api/sync/status` 返回 `health={"healthy":true,"failure_code":null}`，`sync_enabled=true`、`phase=active`；无降级项。
