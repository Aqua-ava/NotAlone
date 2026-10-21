# 07 契约单一来源

Triage: ready-for-agent
State: open

## 目标

消除前后端契约双写：补充/纠正字符上限统一 4096；错误码与 reason 映射集中一处，未知码显式记录并上报，不再静默折叠。

## 证据

- `desktop/src/main/reply/bridge.ts:225` 放行 8193 却报「最多4096」；后端 `reply/interface.py:112,137,142` 为 4096。
- `desktop/src/main/reply/session.ts:1787-1800` 20 分支三元、未知码折叠 `generation_failed`、`canRetry` 兜底 true。
- `desktop/src/main/foreground/controller.ts:16-19` reason 集合少于后端实际原因。
- 复核：`verify-desktop.md` A3。

## 范围

- 桌面共享模块放一份上限常量与错误码/reason 映射；bridge/session/foreground 引用同一来源。
- 未知错误码显式走「未知 + 可重试/不可重试」既定策略并记日志（不新增外发）。
- 后端保持 4096 权威；如桌面意图是支持 8192，需产品确认，本 ticket 按 4096 修。
- 测试：契约测试断言 4096 边界、未知码映射、reason 集合与后端产出集合一致（可复用现有 shared 常量测试）。

## 验收

- `cd desktop && npm run typecheck` + 相关 node test；报告后端无需改动的前提。

## Comments
