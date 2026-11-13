# 01 后端 handler 级 500 记录

Triage: ready-for-agent
State: resolved

## 目标

`BackendApp` 内部 23 处 `except Exception: return 5xx` 不再静默：统一经一个记录点写 `logger.exception`（method、去查询串 path、error_code），响应仍为稳定错误码，不泄露正文/凭据。

## 证据

- `.scratch/code-audit-20261022/verify-structure-defense.md` 第三节 C 组、第四节第 70 行。
- `backend/src/notalone/server/app.py` 23 处（示例 `:549,706,733,784,854,868,892,922,1003,1053,1155,1207,1276,1393,1407,1706,1708,1806,1837,2501,2564,2585,2627`）；顶层 catch-all 在 `:462-472`。

## 范围

- `server/app.py`：新增内部 `_internal_error(...)` 类/helper（或错误响应工厂），记录日志后返回既有状态码与 error 码；替换 23 处。
- 保留既有预期错误映射（400/409/503 的具名错误码）不动，不产生 ERROR 噪声。
- 不把异常 message、正文、token、查询串写入日志。

## 验收

- 新增单测：构造一个内部 handler 抛异常，`assertLogs` 捕获含 method/path/error_code 的 ERROR，断言响应状态/错误码不变、日志不含正文。
- `cd backend && PATH="$HOME/miniconda3/envs/NotAlone/bin:$PATH" python -m unittest tests.unit.server -v` 通过。
- 报告数据影响与剩余风险。

## Comments

- 2026-10-22 backend-cleaner 完成：
  1. `backend/src/notalone/server/app.py` 新增模块级记录点 `_internal_error(method, path, error_code)`：`except` 内走 `logger.exception`（含栈），非异常分支（如 `reply is None`）走 `logger.error`；只记录大写 method、去查询串 path、稳定 error_code，不记录正文/凭据/查询串/异常 message。
  2. 替换 23 处 handler 级 500 + 顶层 catch-all 1 处（原 `backend_request_failed` 日志并入同一点，响应仍为 `internal_error`）。预期错误映射（400/409/503/502/504）未动。
  3. 为原本缺上下文参数的 6 个 handler 补 `path`（`_handle_reply_generate`/`_handle_ledger`/`_handle_cli_binding_revoke`/`_handle_sync_priority`/`_handle_cli_bindings_confirm`/`_handle_sync_confirm`），调用点同步传 `path_value`/`path`；未改路由与响应。
  4. 新增 `tests/unit/server/test_request_error_logging.py::HandlerErrorLoggingTest`：合成 follow-smoke 替身抛异常，断言 500/错误码不变、日志含 method/path/error_code、不含请求正文/查询串/token。
- 验证：`python -m unittest tests.unit.server.test_request_error_logging -v` 3/3 通过；`python -m unittest discover -s tests/unit/server -t . -v` 107/107 通过。
- 数据影响：无迁移、无产品数据写入；仅日志行为变化（handler 级 500 现在有 ERROR+栈，日志量在异常时才增加）。
- 剩余风险：日志含异常栈（含异常 message 与本地路径），沿用既有顶层 catch-all 口径；`_handle_authenticated` 内 catch-all 改为复用记录点，日志文案由 `backend_request_failed` 变为 `backend_handler_failed`，如有外部日志检索需同步。
