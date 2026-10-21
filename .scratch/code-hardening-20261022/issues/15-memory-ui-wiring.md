# 15 记忆 UI 接线

Triage: ready-for-agent
State: open

## 目标

把已实现但不可达的记忆 UI 接回生产记忆页：版本历史、撤销自动更新、关系概览（联系人/本人）。满足「自动采纳可撤销、关系资料可查看/修正/删除」边界。

## 证据

- `desktop/src/renderer/MemoryPage.tsx:208` 返回 `openVersions/revertAutoUpdate/manageLayeredMemory` 但生产 0 调用。
- `MemoryPage.tsx:350-540` 的 `MemoryVersionHistory/ContactRelationshipOverview/OwnerFactsOverview` 无渲染；`LayeredMemoryPanel.tsx`、`OwnerLayeredMemoryPanel.tsx` 仅测试引用。
- `MemoryPage.tsx:571` 已消费 `layeredMemory.value.correctionTarget`（保留）。
- 复核：`verify-desktop.md` A2、`verify-unused.md` A7。

## 范围

- 在记忆页按现有设计接入版本历史与撤销入口；概览面板接线（不新造视觉语言，复用现有组件/样式）。
- 撤销/版本操作走既有 preload 通道；不新增通道。
- 状态发布沿用 controller 现有 revision 协议；不改 main 进程协议。
- 测试：更新 headless/memory-page 场景测试（目前断言 preload 暴露面），补「打开版本历史→撤销自动更新」路径；typecheck + 相关 node tests。

## 验收

- `npm run typecheck` + memory 相关测试；如能安全用 `npm run dev` 则做真实 App 检查，否则明确报告「未做真实 App 验收」。

## Comments
