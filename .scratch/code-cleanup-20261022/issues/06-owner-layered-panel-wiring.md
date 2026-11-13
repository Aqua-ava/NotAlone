# 06 接回 OwnerLayeredMemoryPanel

Triage: ready-for-agent
State: resolved

## 目标

在记忆页「本人」视图提供主题资料自管理入口，使 `OwnerLayeredMemoryPanel` 及其 main/preload 链路可达（A2 推荐：接回）。

## 证据

`.scratch/code-audit-20261022/verify-unused.md` 第 55 行；`review-followups.md` 第 4 项；`MemoryPage.tsx` 现有本人视图与 `LayeredMemoryPanel` 接线方式可参照。

## 范围

- `desktop/src/renderer/MemoryPage.tsx`：本人视图（`view === 'owner'`）增加可展开入口渲染 `OwnerLayeredMemoryPanel`，沿用现有折叠区与 loading/error 模式。
- 复用 `memory.manageLayeredMemory` / `readLayeredMemory` 既有 main/preload 通道；不新增 IPC、不改后端契约。
- 失败时显示可见错误，不静默。

## 验收

- `cd desktop && npm run typecheck` 通过；`npm test` 相关页面用例通过。
- 用已有开发实例（先 `npm run dev:status` 确认 pids=[3898]，不启动第二份）本人视图展开验证：面板渲染状态/计数/管理入口，失败路径可见。
- 记录实际点击路径与结果；不写业务数据（只读展开）。

## Comments

- 2026-10-22 desktop-cleaner：已认领并实现（State: claimed → resolved）。
- 改动：`desktop/src/renderer/MemoryPage.tsx` 引入 `OwnerLayeredMemoryPanel`，在 `view === 'owner'` 增加 `主题资料` 折叠入口（`ownerLayeredSelection` 按 `scopeKey` 重置，展开才渲染，`key` 随资料范围重建），并把面板 `onTrace` 接到既有 `trace('owner_memory')` 证据面板；未改 main/preload、未新增 IPC。
- 通道说明：面板是自包含组件，实际复用的是既有本人分层通道 `memory:owner-layered-state`/`memory:owner-layered-changed`/`memory:read-owner-facts`/`memory:release-owner-layered`/`memory:manage-owner-layered`（`main/memory/bridge.ts:67-81`、`preload/memory.ts:12-24`），而非 ticket 原文所写 `manageLayeredMemory/readLayeredMemory`（那是联系人范围通道）；两者均为既有链路，无契约变更。
- 验证：`cd desktop && npm run typecheck` 通过；`node --test tests/memory-ui-wiring.test.mjs` → 6 pass；`node --test tests/layered-memory/react.test.mjs`（真实 Chromium + 生产记忆桥/控制器）→ 2 pass，覆盖「本人视图展开→面板渲染→经既有 preload 读取本人底层记忆→故意读取失败显示『读取失败，请刷新重试。』」；全量 `npm test` → 973 tests，972 pass / 1 skipped / 0 fail。
- 说明：首次全量 `npm test` 出现 `tests/scheduling/command.test.mjs` 1 例瞬时失败（期望 `app_test_budget` 实得 `app_test_expired`，疑似与并行 Agent 的同机测试/租约时序干扰）；单独重跑该文件 14/14 pass，随后全量重跑 0 fail，判定为环境瞬时干扰而非代码回归。
- UI 验收：未启动/重启 dev。`npm run dev:status` 显示 `{"mode":"development","pids":[38208]}`（当前实例已非 3898，疑似外部重启），本人视图「我 → 主题资料」点击展开与失败路径请 Lead 用该实例复验。
- 需产品决策（先按现有模式实现并标注）：折叠标题沿用联系人视图的「主题资料」，但面板内部 h2 为「我的记忆」，与本人视图页面既有「我的记忆」区标题重复；且该面板只管理本人底层记忆并响应 `correctionTarget`，不渲染分层主题 profile/scenarios，若产品预期「本人主题资料」内容本身，需另行扩展面板（超出本 ticket 范围）。

## Comments

- 2026-10-22 desktop-cleaner 完成接线：`MemoryPage.tsx` 本人视图新增「主题资料」折叠入口，`ownerLayeredOpen` 按 `detailKey` 记忆展开状态、按 `scopeKey` 重建面板；展开才渲染；未改 main/preload、未新增 IPC，复用既有本人分层通道。
- Lead 复核补充：给面板补 `onVersions={openVersions}`，与联系人「主题资料」入口对齐版本历史能力（否则本人面板缺版本入口）。
- 验证：`node --test tests/memory-ui-wiring.test.mjs` 6/6；`node --test tests/layered-memory/react.test.mjs` 2/2（真实 Chromium + 生产记忆桥，含读取失败可见）；复跑两文件 8/8 通过；桌面全量 973 项 972 通过 1 跳过 0 失败（desktop-cleaner 记录）。
- 待产品确认（未阻塞）：折叠标题「主题资料」与面板内「我的记忆」同名区重复；面板只管理本人底层记忆，不渲染分层主题内容。
