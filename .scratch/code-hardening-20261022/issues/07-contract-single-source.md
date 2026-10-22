# 07 契约单一来源

Triage: ready-for-agent
State: resolved

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

- 实现：新增 `desktop/src/shared/reply-contract.ts` 作为回复契约单一来源：`replyTextLimit=4096`（后端 `reply/interface.py` 权威）与 `replyFailureDecision()` 失败码/原因映射（已知码分类明确，未知码返回 `known:false` + 既有可重试策略）。`bridge.ts` 补充内容 8193→4096 并统一引用常量；`session.ts` 删除 20 分支嵌套三元，改用共享映射，未知码走显式分支并 `console.warn` 仅记录 kind/code/reason（无正文）；`StrategyControls` 复用同一上限。
- 前台：`foreground/controller.ts` 删除本地 `awaitingSelectionReasons`，改用共享 `shared/foreground-failure.mjs` 的 `isAwaitingForegroundSelection`；补齐后端会产出的 `session_candidates_truncated`、`sync_disabled`、`sync_gate_unavailable`、`minimal_region_unavailable`、`contact_unavailable` 固定中文说明；新增 `isKnownForegroundReason`，未知原因显式记录一次（只含协议原因码）。
- 测试：`node --test tests/reply-contract.test.mjs` 4/4（上限 4096 边界与无 8193 残留、已知/未知失败码映射、待选原因集合与说明、后端前台原因集合覆盖）；相关回复模块 9 文件 71/71；前台相关 5 文件 30/30；`npm run typecheck` 通过。后端无需改动。
- 数据影响：仅桌面契约常量/映射与日志，不新增外发、不改 preload/数据；日志只含协议码，不含正文或可识别信息。
- 未做真实 App 验收。剩余风险：bridge 硬限 4096 后，历史上 correction+requirements 合计超限的状态只能整体清空重填，`session.updateSupplement` 的「逐步缩短」路径只剩内部兜底；未知码日志进入主进程标准输出，未接统一日志设施。

- 2026-10-22 复核补强：新增 `fitsReplyTextLimit` 按码点计数（`Array.from`），bridge/session 的全部字符上限检查改用它；新增恰好 4096、4097、emoji 边界测试。后端 Python `len` 同为码点计数，前后端单位一致。
- 提交：`491f2be2、47af64fe、e848400b`。
