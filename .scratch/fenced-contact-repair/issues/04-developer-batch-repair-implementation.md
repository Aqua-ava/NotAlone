# 04 开发者批量修复实现

Triage: ready-for-agent
State: resolved（2026-11-06；实现与自动验证完成，真实验收见 05）
Type: task
Blocked by: 01（03 已于 2026-11-05 解除；ADR-173 已采纳但尚未实现）

规格：[../spec.md](../spec.md) 第 6、7 节。开始前先读规格全文、`desktop/src/main/history-clear/controller.ts`、`desktop/src/shared/history-clear-bridge.ts`、`desktop/src/renderer/HistoryClearPanel.tsx`、`backend-ts/src/history/sqlite/recertify.ts` 与 `recertify-actions.ts`。涉及 DSH 的部分按 `docs/agents/dsh-development.md`，本任务预计不涉及。

## 做什么

1. **后端只读候选接口**（规格 6.2）：先核实现有同步状态接口是否已够用；不够再新增，只返回联系人 ID、是否围栏、消息数、图片消息数、未保存图片数；不含名称与正文；查询走索引。
2. **唤醒补丁（仅当任务 01 证明需要）**：`historyRecertify` 的 `onCompleted` 里按 `automaticImages` 开关调用 `imageSync.wake(contactId)`；写测试。
3. **共享解析**：把 `controller.ts` 里的 `recertifyView` 等严格校验抽成共享小模块供批量复用，不复制。
4. **编排器**：`desktop/src/main/history-clear/recertify-batch.ts`，按规格 6.3–6.6 实现（串行、请求键规则、同键查询、失败分类表、连续 3 次熔断、停滞看门狗、停止、重跑幂等、连接代次变化时 `interrupted`、`limit`）。失败码表以后端实际可能返回的全部码补全。
5. **互斥**：批量运行期间，单个“修复同步”、“清空已保存的聊天”、“重新同步”禁用并说明原因；开始前若有这些操作进行中则拒绝。
6. **合同与接线**：共享类型、IPC 桥、预加载。**只在开发宿主注册/暴露**，打包宿主不注册。
7. **界面**：`FencedRepairBatchPanel.tsx`，挂在 `DeveloperTraces` 的 `import.meta.env.DEV` 分支；概览、`limit` 输入、确认弹窗、进度、停止、汇总；文案中文；复用 `.button`。
8. **测试**（规格 7）：后端与桌面逐项覆盖；新增测试登记到 `desktop/tests/inventory.json` 并跑 `pnpm --dir desktop run test:inventory`。
9. **验证**：先单例，再相关模块，最后 `cd desktop && pnpm run typecheck` 与 `cd backend-ts && npx tsc --noEmit`（按各自既有命令）；报告实际运行的命令与结果，不称其为整套测试通过。
10. **提交**：每个主题一个本地提交（后端接口、编排器、界面分开），标题中文，正文 3–5 条含真实验证结果；不推送；提交前跑 `node scripts/check_public_history.mjs --ref HEAD --working-tree`。

## 硬约束（摘自规格 4）

- 不改读取程序、转换组件、记忆处理；不碰 `history_continuity_fence` 等表。
- 不读取或展示聊天正文；日志无名称、正文、明文联系人 ID。
- 只用 `pnpm run dev`，先 `dev:status` 复用；不打包、不运行打包版。
- 工作树里有其他会话的未提交改动时，只暂存本任务文件，不捎带他人修改。

## 验收

- 规格第 7 节列出的自动测试全部存在并通过；打包宿主不暴露批量入口有测试证明。
- 现有 `history-recertify*.test.mjs`、`sqlite-history-clear-contract.test.mjs`、`sqlite-history-clearing.test.mjs` 与后端 `sqlite-history-recertify*.test.mjs` 不回归。
- 在真实开发 App 里没有桌面操作工具时，写明“界面未实操验收”，留给任务 05。
- 数据处理影响、已运行命令、剩余风险写入提交正文或验收记录。

## Comments

## Comments

- 2026-11-06 实现完成：3 个本地提交 b357f4706（后端只读候选接口）、6a1ea82de（编排器与开发宿主接线）、76b9df33b（开发者调试区面板与视图测试）。
- 自验：后端候选 5/5、recertify/clear-http 59/59；桌面批量 18/18、安全 9/9、桥 4/4、view 7/7；既有回归 58/58 + 17/17；desktop typecheck、backend tsc、test:inventory 通过；真实后端只读冒烟 200。
- lead 复跑：desktop/backend typecheck 通过，新增桌面 38/38、后端 26/26，inventory 通过。
- 真实界面与批量运行由任务 05 验收；本单不再改产品代码。
