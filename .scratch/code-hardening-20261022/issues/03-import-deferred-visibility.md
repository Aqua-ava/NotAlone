# 03 导入 deferred 可见

Triage: ready-for-agent
State: resolved
Blocked by: 01

## 目标

历史导入返回 200 但后台提取未启动时，调用方/用户能看到「处理已延后」；任务装配失败不再静默。

## 证据

- `app.py` 导入提交后 wake/defer 失败被吞（约 `:2262-2283` 附近，按 HEAD 核对）。
- `memory_extraction/command.py:454-463` 附近装配失败 `return None` 无日志。
- 恢复扫描实际在 `extraction_schedule.py:86` + `application/import_service.py:206-211`（旧报告行号错）。
- 复核：`verify-backend.md` A3。

## 范围

- 导入响应增加 `processing_deferred: true`（仅延迟时）；延迟原因写 runtime status/degraded 列表。
- 装配失败路径至少 logger.warning（不泄露路径/正文）。
- 测试：fake scheduler 抛错/返回 None，断言响应字段与状态；成功路径不出现该字段。

## 验收

- 相关导入/服务集成测试；报告桌面端是否消费该字段（若不消费，记录后续 ticket）。

## Comments

- 2026-10-22 完成：`/api/imports/commit` 在 task_host 缺失、wake 失败、任务身份非法或 defer 失败时，响应追加 `processing_deferred: true` 与稳定 `deferred_reason`（`task_host_unavailable`/`wake_failed`/`task_identity_invalid`/`defer_failed`），成功路径保持原响应形状；失败原因写入 `/api/runtime/status` 的 `degraded` 列表（只含 code/reason/at），成功 wake 后清除。
- `server/command.py` 的 `_build_task_host` 装配失败不再静默 `return None`，改为 warning（只记异常类型名）。
- 旧报告引用的「恢复扫描在 command.py:454-463」行号错误；实际恢复循环在 `application/import_service.py:198-221`（`extract_schedule.recover_due`，已有 warning）。
- 桌面端目前不消费 `processing_deferred`/`degraded`；已在 ticket 15/后续 UI 范围内记录，本轮不改桌面。
- 验证：`python -m unittest tests.unit.server.test_import_processing_visibility -v` 4 条通过；`python -m unittest discover -s tests/unit/server -t .` 101 条通过。
- 数据影响：无 schema/数据变更；HTTP/状态 JSON 只新增字段。剩余风险：defer 成功但扫描线程未启动的装配问题仍依赖 command.py 的 warning 暴露，桌面不会主动提示。
- Commit：见 `git log --grep '导入'`。

- 2026-10-22 复核修复：只有成功排入 `defer` 队列才返回 `processing_deferred: true`；`defer` 失败或任务身份缺失返回 `processing_deferred: false` + `processing_unavailable: true`，不再把「未入队」说成「已延后」。
- 后续项：桌面/状态页尚未消费 `processing_deferred`/`processing_unavailable`/`degraded`，已登记到 `review-followups.md`。
