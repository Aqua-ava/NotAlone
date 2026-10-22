# 05 桌面首帧读取失败写 error

Triage: ready-for-agent
State: resolved

## 目标

首帧状态读取失败不再永久停在「读取中/不可用」：useRevisionedSession 等首帧读取处把错误写入可见状态，提供重试。

## 证据

- `desktop/src/renderer/use-revisioned-session.ts:25-31`：`void bridge.getState().then(receive).catch(() => {})`。
- 同类首帧空 catch 约 10 处（ForegroundPanel/StartupSettings/use-binding-consent/MemoryPage/ImportPage/SetupPanel/backend-status/WechatSetupPanel 等），清理/取消类空 catch 保留。
- 复核：`verify-desktop.md` A1。

## 范围

- 修 useRevisionedSession 与明确属于首帧读取的站点；清理类空 catch 不改（注释说明保留）。
- 若 hook 无 error 通道，用现有 setError/错误状态接口；不新增全局状态框架。
- 测试：node test（hook/页面现有测试栈）覆盖 reject → error 可见、重试可恢复。

## 验收

- `cd desktop && npm run typecheck` + 相关 `node --test`；报告未做真实 App 验收。

## Comments

- 实现：新增 `desktop/src/renderer/initial-read.ts` 统一首帧读取入口（失败写 `状态读取失败，请重试。`，成功后清空错误；并发只读一次；失活/卸载时不写状态），新增 `FirstFrameError` 可见提示与重试按钮。
- 接线：`use-revisioned-session.ts`（RewritePanel/SyncControlPanel/SkillLearningPage/ExpressionPreferences/contact-session 消费方）失败写 error 并暴露 `retry`；`use-binding-consent`、`useMemoryReading`、`ImportPage`、`SetupPanel`、`WechatSetupPanel` 增加独立首帧错误通道与重试；`useForegroundState`/`useStartupState`/`useBackendState` 返回 `{state,error,retry}` 并在 `index.tsx` 展示。清理/取消类空 catch（releaseLayeredMemory、cancelProcessingRead、刷新动作、列表滚动等）保持静默不改。
- 验证：`cd desktop && npm run typecheck` 通过；`node --test tests/first-frame-read.test.mjs` 4/4 通过（覆盖 reject→error、重试恢复、并发去重、卸载后不写状态）；相关 safe-node 10 个文件 84/84 通过；`node scripts/test-safe.mjs` 全量 safe-node 见提交正文。
- 数据影响：不改数据通道、不新增 preload；仅 renderer 本地错误状态与提示，日志不含正文/路径。
- 未做真实 App 验收（本轮约束不运行 `npm run dev`）。
- 剩余风险：只覆盖首帧读取用 `getState` 的失败路径；页面若在首次 `getState` 失败前收到推送状态则错误自动清除（由 receive 覆盖）。其他 `catch(() => {})` 中仍混有刷新动作类静默，未纳入本 ticket。

- 2026-10-22 复核补漏：`OwnerLayeredMemoryPanel` 的 `getOwnerLayeredMemoryState()` 首帧失败也会写 error（该面板当前尚未接线，仍按首帧读取规则处理）。
- 2026-10-22 真机只读：联系人页与记忆页正常加载，未出现首帧读取错误提示；强制读取失败路径未注入。
- 提交：`17711937`。
