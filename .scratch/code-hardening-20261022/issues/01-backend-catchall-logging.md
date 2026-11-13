# 01 后端异常单点日志

Triage: ready-for-agent
State: resolved

## 目标

让后端未预期异常可诊断：`BackendApp` 的 catch-all 记录一条含 method/path/error_code 的日志（正文与敏感信息脱敏），不再只返回 `internal_error`。

## 证据

- `backend/src/notalone/server/app.py:405-423` 外层 `except Exception` 只构造 500。
- 同文件 24 处 `except Exception`；`server/` 包仅 3 处 logging。
- 复核：`.scratch/code-review-20261022/verify-backend.md` A1/A2。

## 范围

- `backend/src/notalone/server/app.py`：模块 logger；catch-all 单点 `logger.exception`；必要时把异常类型/错误码写入日志。
- 不逐 handler 加日志（留给 02/03 的具名失败路径）。

## 验收

- 新增单元/集成测试：注入抛异常的路由处理，断言返回 500 且 `assertLogs` 捕获含 method/path 的记录，日志不含请求正文。
- 相关测试：`cd backend && PATH="$HOME/miniconda3/envs/NotAlone/bin:$PATH" python -m unittest tests.unit.server... tests.integration.server... -v`（按实际模块）。
- 报告数据影响与剩余风险。

## Comments

- 2026-10-22 完成：`app.py` 增加模块级 `logger`；`_handle_request` 兜底 `except Exception` 记录 `backend_request_failed method=... path=...`（`urlsplit` 去查询串，附异常栈），响应仍为稳定 `internal_error`。
- 预期领域错误（`ManagedUpdateBackupError`、`SyncHostStopped`/`ModelWorkStopped`）不进入该日志，避免噪声。
- 新增 `backend/tests/unit/server/test_request_error_logging.py`：覆盖异常日志含 method/path、不含请求正文/查询串；预期错误不触发 ERROR。
- 验证：`python -m unittest tests.unit.server.test_request_error_logging -v` 2 条通过；`python -m unittest discover -s tests/unit/server -t .` 91 条通过。
- 数据影响：无 schema/数据变更；仅本地日志。剩余风险：异常消息由 Python 异常自带，若未来某异常 message 主动拼接正文会进入日志，代码评审时需守住。
- 提交：`8278cdf9`。
