# 01 后端异常单点日志

Triage: ready-for-agent
State: open

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
