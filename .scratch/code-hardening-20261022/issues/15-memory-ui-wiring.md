# 15 记忆 UI 接线

Triage: ready-for-agent
State: resolved

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

## Comments

- 实现：记忆页重新接回已实现但不可达的 UI —— ①「版本历史」折叠区（`MemorySecondaryPanels`）：联系人视图渲染 `ContactRelationshipOverview` + `MemoryVersionHistory`，本人视图渲染 `OwnerFactsOverview` + 本人层 `MemoryVersionHistory`；②活跃记忆卡片新增「查看版本历史」入口，调用既有 `memory:open-versions` 后展开面板，撤销自动更新复用既有 `memory:revert-auto-update`；③`refresh()` 恢复并行读取联系人概览/本人概览（既有 `memory:refresh-overview`/`memory:refresh-owner-overview`）；④「主题资料」折叠区按需渲染既有 `LayeredMemoryPanel`，`manageLayeredMemory` 由此获得生产入口（默认折叠，未点开时 DOM 无该区域，不影响既有页面断言）。
- 边界：未新增 preload 通道（渲染层无 `invoke(`，全部复用既有 manager 通道）；保留 `layeredMemory.value?.correctionTarget` 的纠错定位依赖；概览仅为已采纳资料投影，不改变联系人/owner 隔离与人工发送边界；文案沿用现有中文。
- 测试：新增 `tests/memory-ui-wiring.test.mjs` 5/5（联系人/本人面板渲染与撤销入口、空历史不渲染空壳、活跃/失效卡片入口差异、接线与无新通道+correctionTarget 保留）；相关记忆 node 测试 63/63；`npm run typecheck`、`test:inventory` 通过；全量 safe-node 983 项 982 通过 1 跳过。更新 `tests/headless/contact-relationship-overview.ts` 的旧断言与 `tests/memory-event-updates.test.mjs` 的入口断言；headless/浏览器场景未执行（默认门禁不含、本机未装 Playwright 浏览器）。
- 未做真实 App 验收（本轮约束不运行 `npm run dev`）：折叠区实际观感、展开后滚动定位、撤销确认流程只经静态渲染与源码接线验证。
- 剩余风险：①`OwnerLayeredMemoryPanel`（自管理本人主题资料）仍未接回，现有 headless 场景断言记忆页默认不出现「主题资料」区域，是否接回需产品确认；②概览读取纳入整页刷新后，概览失败会显示合并错误提示（与旧实现一致）；③真实 App 交互未验证。
