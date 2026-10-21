# 05 桌面首帧读取失败写 error

Triage: ready-for-agent
State: open

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
